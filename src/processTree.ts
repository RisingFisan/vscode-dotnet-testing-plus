import { ChildProcess, SpawnOptions, execFile, execFileSync, spawn } from 'child_process';

/** Children spawned through {@link spawnTracked} that have not exited yet. */
const liveChildren = new Set<ChildProcess>();
/** Children that lead their own POSIX process group (killable with one syscall). */
const groupLeaders = new WeakSet<ChildProcess>();

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Spawn a child that {@link killProcessTree} can terminate reliably. On POSIX
 * the child becomes a process-group leader, so the whole tree (testhost,
 * webdrivers, browsers...) can be signalled with a single synchronous
 * `kill(-pid)`; no `pgrep`/`ps` walk is needed and it also works while the
 * extension host is shutting down. On Windows `taskkill /T` handles the tree.
 */
export function spawnTracked(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const detached = process.platform !== 'win32';
  const child = spawn(command, args, { ...options, detached });
  if (detached) {
    groupLeaders.add(child);
  }
  liveChildren.add(child);
  const forget = (): void => {
    liveChildren.delete(child);
  };
  child.once('exit', forget);
  child.once('error', forget);
  return child;
}

/**
 * Recursively terminates a child process and all of its descendants.
 * This prevents orphaned processes (such as VSTest testhost, Selenium webdrivers,
 * and spawned browsers) from staying open when a run or build is cancelled.
 * Safe to call repeatedly and on children that already exited (a no-op: the
 * PID may since have been reused by an unrelated process).
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
  if (hasExited(child)) {
    return;
  }
  if (!pid) {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    return;
  }

  if (process.platform === 'win32') {
    // On Windows, taskkill /F /T kills the specified process and all child processes started by it.
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], err => {
      if (err && !hasExited(child)) {
        // Fall back to direct kill if taskkill failed or was not available
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      }
    });
    return;
  }

  if (groupLeaders.has(child)) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group already gone or not signalable; fall through to the direct kill.
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    return;
  }

  // Not a group leader (spawned outside spawnTracked): snapshot the process
  // table once and kill the descendants bottom-up.
  findDescendantPids(pid, descendants => {
    if (hasExited(child)) {
      return;
    }
    for (const p of [...descendants.reverse(), pid]) {
      try {
        process.kill(p, signal);
      } catch {
        // Process might have already exited
      }
    }
  });
}

/**
 * Synchronously kill every tracked child that is still alive. Used on
 * deactivate, where asynchronous cleanup would not get a chance to finish.
 */
export function killAllTrackedChildren(): void {
  for (const child of [...liveChildren]) {
    if (hasExited(child) || !child.pid) {
      continue;
    }
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 3000 });
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
  liveChildren.clear();
}

/** Parse `ps -A -o pid=,ppid=` output into a parent -> children map. */
export function parseProcessTable(stdout: string): Map<number, number[]> {
  const parentToChildren = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    if (isNaN(pid) || isNaN(ppid)) {
      continue;
    }
    const list = parentToChildren.get(ppid);
    if (list) {
      list.push(pid);
    } else {
      parentToChildren.set(ppid, [pid]);
    }
  }
  return parentToChildren;
}

/** Breadth-first descendants of `rootPid` (excluding it) from a process table. */
export function descendantsOf(rootPid: number, table: ReadonlyMap<number, number[]>): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let i = 0; i < queue.length; i++) {
    for (const child of table.get(queue[i]) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

function findDescendantPids(rootPid: number, cb: (pids: number[]) => void): void {
  execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
    if (err || !stdout) {
      cb([]);
      return;
    }
    cb(descendantsOf(rootPid, parseProcessTable(stdout)));
  });
}
