// Two guards that only make sense once a task may edit a component, not just a stylesheet.
//
// `typeChecker` runs the project's own TypeScript over its own tsconfig. A component that does not compile takes
// the running page down, so the result decides whether the write is kept.
//
// It answers with three states, never two: `passed`, `failed`, or `unknown` — the compiler was not there, did
// not finish, or could not be run. "We could not check" is not "it is fine", and nothing downstream may treat it
// as a pass: an unverified version is not one the user should be asked to adopt.
//
// `baselineSnapshotter` records the region's sources in a git repository that belongs to the copy alone, so
// there is a second way back that does not depend on the studio's own bookkeeping.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Always returns a checker. If the project has no TypeScript, the checker reports `unknown` with the reason,
// rather than quietly disappearing and leaving the caller to assume everything is well.
export function typeChecker({ projectRoot, timeoutMs = 180000 }) {
  const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const tsconfig = path.join(projectRoot, 'tsconfig.json');
  return async () => {
    if (!fs.existsSync(tsc)) return { status: 'unknown', message: `no TypeScript in ${path.relative(projectRoot, tsc)}, so the change could not be type-checked` };
    if (!fs.existsSync(tsconfig)) return { status: 'unknown', message: 'the project has no tsconfig.json, so the change could not be type-checked' };
    const started = Date.now();
    try {
      await run(process.execPath, [tsc, '-p', tsconfig, '--noEmit'], { cwd: projectRoot, timeout: timeoutMs, maxBuffer: 8 << 20 });
      return { status: 'passed', message: '', ms: Date.now() - started };
    } catch (e) {
      if (e.killed || e.signal) return { status: 'unknown', message: `the type check did not finish within ${Math.round(timeoutMs / 1000)}s, so the change is not verified`, ms: Date.now() - started };
      if (e.code === 'ENOENT') return { status: 'unknown', message: `the type checker could not be started (${e.message})` };
      // tsc writes its errors to stdout; the first lines are the ones that name the mistake.
      const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').filter(Boolean).slice(0, 6).join('\n');
      return { status: 'failed', message: out || String(e.message), ms: Date.now() - started };
    }
  };
}

export async function baselineSnapshotter(modulePath) {
  if (!modulePath || !fs.existsSync(modulePath)) return null;
  const m = await import(`file://${modulePath}`);
  if (typeof m.snapshot !== 'function') return null;
  return async (label) => {
    try { return m.snapshot(label); } catch { return null; } // a snapshot that fails must not stop a legal write
  };
}
