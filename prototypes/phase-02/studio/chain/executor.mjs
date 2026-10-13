// Controlled execution layer: task baseline, guarded apply, guarded restore.
// Phase02 W3 copy of the accepted Phase01 executor (via the W2 lab copy). Only change: createTask({ expectedBase }).
// Every write is checked against: task status, baseline hash, allowlist, and the
// real (symlink-resolved) path staying inside the project root.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class ChainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function createExecutor({ projectRoot, registry, patchesDir, stateDir }) {
  const root = fs.realpathSync(projectRoot);
  const tasksDir = path.join(stateDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const taskFile = (id) => path.join(tasksDir, id, 'task.json');
  const saveTask = (t) => fs.writeFileSync(taskFile(t.taskId), JSON.stringify(t, null, 2));

  // Resolve a project-relative path and prove it stays inside root after symlinks.
  function resolveInside(rel) {
    if (typeof rel !== 'string' || rel.length === 0 || path.isAbsolute(rel)) {
      throw new ChainError('PATH_OUTSIDE_ROOT', `Path must be project-relative: ${rel}`, { file: rel });
    }
    const abs = path.resolve(root, rel);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new ChainError('PATH_MISSING', `File does not exist: ${rel}`, { file: rel });
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new ChainError('PATH_OUTSIDE_ROOT', `Resolved path leaves the project root: ${rel} -> ${real}`, { file: rel, resolved: real });
    }
    return real;
  }

  const hashFile = (rel) => sha256(fs.readFileSync(resolveInside(rel)));

  function writeAtomic(abs, content) {
    const tmp = `${abs}.chain-tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
  }

  function loadPatch(patchId) {
    if (!/^[a-z0-9-]+$/.test(patchId)) throw new ChainError('PATCH_UNKNOWN', `Invalid patch id: ${patchId}`);
    const file = path.join(patchesDir, `${patchId}.json`);
    if (!fs.existsSync(file)) throw new ChainError('PATCH_UNKNOWN', `No such patch: ${patchId}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function region(regionId) {
    const r = registry.regions[regionId];
    if (!r) throw new ChainError('REGION_UNREGISTERED', `Region is not registered: ${regionId}`, { regionId });
    return r;
  }

  function getTask(taskId) {
    if (!/^[0-9a-f-]{36}$/.test(taskId) || !fs.existsSync(taskFile(taskId))) {
      throw new ChainError('TASK_UNKNOWN', `No such task: ${taskId}`);
    }
    return JSON.parse(fs.readFileSync(taskFile(taskId), 'utf8'));
  }

  // W3 copy: `expectedBase` ({ file: sha256 }) binds the task to the version the handoff was made on; if the files
  // changed since then (external edit), the task is refused before any baseline is taken.
  function createTask({ regionId, patchId, patchOverride, expectedBase }) {
    const r = region(regionId);
    const patch = patchOverride ?? loadPatch(patchId);
    if (patch.regionId !== regionId) {
      throw new ChainError('PATCH_REGION_MISMATCH', `Patch ${patch.patchId} is for ${patch.regionId}, not ${regionId}`);
    }
    if (expectedBase) {
      const changed = r.allowedFiles.filter((rel) => expectedBase[rel] && hashFile(rel) !== expectedBase[rel]);
      if (changed.length) throw new ChainError('STALE_BASELINE', `Source changed since the handoff version: ${changed.join(', ')}`, { files: changed });
    }
    const taskId = randomUUID();
    const dir = path.join(tasksDir, taskId);
    fs.mkdirSync(path.join(dir, 'base'), { recursive: true });
    const files = {};
    for (const rel of r.allowedFiles) {
      const buf = fs.readFileSync(resolveInside(rel));
      files[rel] = { baseHash: sha256(buf) };
      const backup = path.join(dir, 'base', rel);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, buf);
    }
    const baseVersion = sha256(Object.entries(files).map(([f, v]) => `${f}:${v.baseHash}`).join('\n'));
    const task = {
      taskId,
      regionId,
      component: r.component,
      sourceFile: r.sourceFile,
      patchId: patch.patchId,
      patchKind: patch.kind,
      patchTitle: patch.title,
      patch,
      allowedFiles: r.allowedFiles,
      preserve: r.preserve,
      baseVersion,
      files,
      status: 'pending',
      history: [{ at: new Date().toISOString(), status: 'pending' }],
    };
    saveTask(task);
    return task;
  }

  function setStatus(task, status, extra = {}) {
    task.status = status;
    task.history.push({ at: new Date().toISOString(), status, ...extra });
    saveTask(task);
  }

  function reject(task, code, message, details) {
    task.history.push({ at: new Date().toISOString(), status: task.status, rejected: code, message });
    saveTask(task);
    throw new ChainError(code, message, details);
  }

  function applyTask(taskId) {
    const task = getTask(taskId);
    if (task.status !== 'pending') {
      reject(task, 'TASK_NOT_PENDING', `Task is ${task.status}; only pending tasks can be applied`);
    }
    // 1. Validate every target path before touching anything.
    const byFile = new Map();
    for (const edit of task.patch.edits) {
      let abs;
      try {
        abs = resolveInside(edit.file);
      } catch (e) {
        reject(task, e.code, e.message, e.details);
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!task.allowedFiles.includes(rel)) {
        reject(task, 'PATH_NOT_ALLOWED', `File is not in this task's allowlist: ${edit.file}`, { file: edit.file, allowed: task.allowedFiles });
      }
      if (!byFile.has(rel)) byFile.set(rel, { abs, edits: [] });
      byFile.get(rel).edits.push(edit);
    }
    // 2. Baseline check: every allowed file must still match the task baseline.
    const changed = task.allowedFiles.filter((rel) => hashFile(rel) !== task.files[rel].baseHash);
    if (changed.length) {
      reject(task, 'STALE_BASELINE', `Source changed since the task was created: ${changed.join(', ')}`, { files: changed });
    }
    // 3. Compute new contents in memory; each find must match exactly once.
    const out = [];
    for (const [rel, { abs, edits }] of byFile) {
      const raw = fs.readFileSync(abs, 'utf8');
      const crlf = raw.includes('\r\n'); // keep the file's own line endings (git autocrlf on Windows)
      let text = raw.replace(/\r\n/g, '\n');
      for (const { find, replace } of edits) {
        const n = text.split(find).length - 1;
        if (n !== 1) reject(task, 'PATCH_NO_MATCH', `Edit target found ${n} times in ${rel}`, { file: rel });
        text = text.replace(find, () => replace);
      }
      out.push({ rel, abs, text: crlf ? text.replace(/\n/g, '\r\n') : text });
    }
    // 4. Write, then record hashes and a real diff against the baseline backup.
    setStatus(task, 'applying');
    for (const { abs, text } of out) writeAtomic(abs, text);
    for (const { rel } of out) {
      task.files[rel].afterHash = hashFile(rel);
      task.files[rel].diff = diffAgainstBase(task, rel);
    }
    for (const rel of task.allowedFiles) task.files[rel].afterHash ??= task.files[rel].baseHash;
    setStatus(task, 'applied');
    return task;
  }

  function diffAgainstBase(task, rel) {
    const base = path.join(tasksDir, task.taskId, 'base', rel);
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', base, resolveInside(rel)], { encoding: 'utf8' });
    return (r.stdout || '').replace(/^diff --git .*$/m, `diff --git a/${rel} b/${rel}`)
      .replace(/^--- .*$/m, `--- a/${rel} (baseline)`).replace(/^\+\+\+ .*$/m, `+++ b/${rel} (task ${task.taskId.slice(0, 8)})`);
  }

  function restoreTask(taskId) {
    const task = getTask(taskId);
    if (task.status !== 'applied') {
      reject(task, 'TASK_NOT_APPLIED', `Task is ${task.status}; only applied tasks can be restored`);
    }
    // Refuse to overwrite anything changed after this task was applied.
    const conflicts = task.allowedFiles.filter((rel) => hashFile(rel) !== task.files[rel].afterHash);
    if (conflicts.length) {
      reject(task, 'RESTORE_CONFLICT', `Changed outside this task after it was applied; not overwriting: ${conflicts.join(', ')}`, { files: conflicts });
    }
    for (const rel of task.allowedFiles) {
      writeAtomic(resolveInside(rel), fs.readFileSync(path.join(tasksDir, task.taskId, 'base', rel)));
      const h = hashFile(rel);
      if (h !== task.files[rel].baseHash) {
        setStatus(task, 'failed', { message: `Restore hash mismatch for ${rel}` });
        throw new ChainError('RESTORE_VERIFY_FAILED', `Restored ${rel} does not match baseline hash`);
      }
      task.files[rel].restoredHash = h;
    }
    setStatus(task, 'restored');
    return task;
  }

  function listTasks() {
    return fs.readdirSync(tasksDir).filter((d) => fs.existsSync(taskFile(d))).map((d) => getTask(d))
      .sort((a, b) => a.history[0].at.localeCompare(b.history[0].at));
  }

  return { root, createTask, applyTask, restoreTask, getTask, listTasks, hashFile, region };
}
