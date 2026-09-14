import { ChildProcess, execFile } from 'child_process';

/**
 * Recursively terminates a child process and all of its descendants.
 * This prevents orphaned processes (such as VSTest testhost, Selenium webdrivers,
 * and spawned browsers) from staying open when a run or build is cancelled.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
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
      if (err) {
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

  // On POSIX / Linux / macOS (including WSL):
  // Collect all descendant PIDs using pgrep or /proc and kill them bottom-up.
  findDescendantPids(pid, descendants => {
    // Kill descendants first (bottom-up), then the root process
    const allPids = [...descendants.reverse(), pid];
    for (const p of allPids) {
      try {
        process.kill(p, signal);
      } catch {
        // Process might have already exited
      }
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  });
}

function findDescendantPids(rootPid: number, cb: (pids: number[]) => void): void {
  // Use pgrep -P to find child processes recursively
  execFile('pgrep', ['-P', String(rootPid)], (err, stdout) => {
    if (err || !stdout.trim()) {
      // If pgrep fails or returns empty, try ps as fallback
      fallbackFindDescendantPids(rootPid, cb);
      return;
    }

    const immediate = stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(p => !isNaN(p) && p > 0);

    if (immediate.length === 0) {
      cb([]);
      return;
    }

    let remaining = immediate.length;
    const collected: number[] = [...immediate];

    for (const childPid of immediate) {
      findDescendantPids(childPid, subChildren => {
        collected.push(...subChildren);
        remaining--;
        if (remaining === 0) {
          cb(Array.from(new Set(collected)));
        }
      });
    }
  });
}

function fallbackFindDescendantPids(rootPid: number, cb: (pids: number[]) => void): void {
  // Fallback: parse ps -ef or ps -A -o pid,ppid
  execFile('ps', ['-A', '-o', 'pid,ppid'], (err, stdout) => {
    if (err || !stdout) {
      cb([]);
      return;
    }

    const parentToChildren = new Map<number, number[]>();
    const lines = stdout.trim().split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        if (!isNaN(pid) && !isNaN(ppid)) {
          const list = parentToChildren.get(ppid) ?? [];
          list.push(pid);
          parentToChildren.set(ppid, list);
        }
      }
    }

    const descendants: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = parentToChildren.get(curr);
      if (children) {
        for (const c of children) {
          descendants.push(c);
          queue.push(c);
        }
      }
    }

    cb(descendants);
  });
}
