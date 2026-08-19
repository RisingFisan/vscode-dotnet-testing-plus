import * as path from 'path';
import * as fs from 'fs';

export function findDefaultRunsettings(solutionPath: string): string | undefined {
  const slnDir = path.dirname(solutionPath);
  const slnName = path.basename(solutionPath, '.sln');
  const candidates: string[] = [];
  try {
    for (const entry of fs.readdirSync(slnDir)) {
      if (entry.toLowerCase().endsWith('.runsettings')) {
        candidates.push(path.join(slnDir, entry));
      }
    }
  } catch {
    return undefined;
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const sameBase = candidates.find(c => path.basename(c, '.runsettings').toLowerCase() === slnName.toLowerCase());
  if (sameBase) {
    return sameBase;
  }

  const namedDefault = candidates.find(c => path.basename(c, '.runsettings').toLowerCase() === 'default');
  if (namedDefault) {
    return namedDefault;
  }

  return candidates[0];
}

export function resolveRunsettingsPath(solutionPath: string, explicitPath: string | undefined): string | undefined {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  return findDefaultRunsettings(solutionPath);
}
