// Which code is actually running.
//
// Node loads a module once and keeps it; editing a file changes nothing until the process restarts. During W5 a
// fix was on disk while the server kept serving the version it had started with, and the server log and the
// source disagreed for half an hour. So the server states a fingerprint of the files it loaded, the workbench
// shows it, and `node checks/code-version.mjs` compares it with the files on disk right now.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Everything that runs inside the server process. The workbench is a separate build and is not covered here.
const DIRS = ['runtime', 'graph', 'server', 'chain'];

export function sourceFiles() {
  const files = [];
  for (const d of DIRS) {
    const dir = path.join(pkg, d);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.mjs')) files.push(`${d}/${name}`);
  }
  return files.sort();
}

export function codeVersion() {
  const h = createHash('sha256');
  const files = sourceFiles();
  for (const rel of files) {
    h.update(rel);
    h.update(fs.readFileSync(path.join(pkg, rel)).toString('utf8').replace(/\r\n/g, '\n'));
  }
  const hash = h.digest('hex');
  return { short: hash.slice(0, 12), hash, files: files.length };
}

// Frozen when the process starts: later edits on disk cannot change it, which is the whole point.
export const RUNNING = { ...codeVersion(), startedAt: new Date().toISOString() };
