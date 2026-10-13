// Versions of the registered region (W4): label + disk hash + a content snapshot per observed version, restore to
// any earlier snapshot THROUGH the Phase01 executor (allowlist, expected baseline, atomic write), and diffs between
// versions. A restore expects the disk to equal the running version the studio last recorded; if someone changed the
// file outside the studio, the executor refuses (STALE_BASELINE → RESTORE_CONFLICT) and the external change stays.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export function versionOf(exec, region) {
  const files = Object.fromEntries(region.allowedFiles.map((f) => [f, exec.hashFile(f)]));
  const hash = sha(Object.entries(files).map(([f, h]) => `${f}:${h}`).join('\n'));
  return { files, hash, short: hash.slice(0, 8) };
}

const snapName = (fileHash, i) => `ver-${fileHash.slice(0, 16)}-${i}.bin`;

// Record the current disk version as an observed version (snapshot stored once per content hash).
export function observeVersion(ctx, { kind, extra = {} }) {
  const { store, exec } = ctx;
  const region = ctx.region();
  const v = versionOf(exec, region);
  const snapshot = {};
  region.allowedFiles.forEach((rel, i) => {
    const name = snapName(v.files[rel], i);
    if (!fs.existsSync(store.binaryPath(name))) store.saveBinary(name, fs.readFileSync(path.join(ctx.projectRoot, rel)));
    snapshot[rel] = name;
  });
  const p = store.project();
  const known = [...p.versions].reverse().find((x) => x.hash === v.hash);
  const label = known?.label ?? (kind === 'original' ? 'v1' : `v${new Set(p.versions.map((x) => x.label)).size + 1}`);
  store.append({ type: 'version_observed', payload: { label, kind, files: v.files, hash: v.hash, snapshot, ...extra } });
  return { ...v, label, snapshot };
}

// Targets a user can restore to: original, previous (the version before the running one), adopted.
export function restoreTargets(p) {
  const running = p.running;
  if (!running) return {};
  const distinct = [];
  for (const v of p.versions) if (distinct.at(-1)?.hash !== v.hash) distinct.push(v);
  const original = p.versions.find((v) => v.kind === 'original');
  const idx = distinct.map((v) => v.hash).lastIndexOf(running.hash);
  const previous = idx > 0 ? distinct[idx - 1] : null;
  const adopted = p.adopted ? p.versions.find((v) => v.hash === p.adopted.hash) : null;
  // One entry per distinct content: adopted first, then original, then previous.
  const t = {};
  const seen = new Set([running.hash]);
  for (const [k, v] of [['adopted', adopted], ['original', original], ['previous', previous]]) {
    if (v && !seen.has(v.hash)) { t[k] = v; seen.add(v.hash); }
  }
  return t;
}

// Restore the region's files to `target` (a version_observed record with snapshot names).
export function restoreTo(ctx, { target, label, decisionSeq, targetName }) {
  const { store, exec } = ctx;
  const region = ctx.region();
  const p = store.project();
  const now = versionOf(exec, region);
  if (now.hash !== p.running.hash) {
    return { ok: false, code: 'RESTORE_CONFLICT', reason: `Not restored: ${region.allowedFiles.join(', ')} was changed outside the studio after the last recorded version (${p.running.label}). The outside change was kept.` };
  }
  const edits = [];
  for (const rel of region.allowedFiles) {
    const cur = fs.readFileSync(path.join(ctx.projectRoot, rel), 'utf8').replace(/\r\n/g, '\n');
    const want = fs.readFileSync(store.binaryPath(target.snapshot[rel]), 'utf8').replace(/\r\n/g, '\n');
    if (cur !== want) edits.push({ file: rel, find: cur, replace: want });
  }
  let execTaskId = null;
  if (edits.length) {
    try {
      const t = exec.createTask({ regionId: region.regionId, expectedBase: p.running.files, patchOverride: { patchId: `restore-${target.label}`, regionId: region.regionId, kind: 'restore', title: `Restore ${target.label}`, origin: `decision#${decisionSeq}`, keep: [], edits } });
      exec.applyTask(t.taskId);
      execTaskId = t.taskId;
    } catch (e) {
      const code = e.code === 'STALE_BASELINE' ? 'RESTORE_CONFLICT' : e.code || 'RESTORE_FAILED';
      return { ok: false, code, reason: code === 'RESTORE_CONFLICT' ? `Not restored: the file changed outside the studio. The outside change was kept.` : `Restore failed: ${e.message}` };
    }
  }
  const after = versionOf(exec, region);
  if (after.hash !== target.hash) return { ok: false, code: 'RESTORE_VERIFY_FAILED', reason: `Restore wrote the file but its hash (${after.short}) does not match ${target.label} (${target.hash.slice(0, 8)}).` };
  const v = observeVersion(ctx, { kind: 'restored', extra: { restoredFrom: p.running.label } });
  return { ok: true, execTaskId, to: v, label: label ?? v.label, targetName };
}

// Unified diff between two versions' snapshots (or a snapshot and the current file).
export function diffSnapshots(ctx, fromVersion, rel) {
  const a = ctx.store.binaryPath(fromVersion.snapshot[rel]);
  const b = path.join(ctx.projectRoot, rel);
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8' });
  return (r.stdout || '').replace(/^diff --git .*$/m, `diff --git a/${rel} b/${rel}`)
    .replace(/^--- .*$/m, `--- a/${rel} (${fromVersion.label})`).replace(/^\+\+\+ .*$/m, `+++ b/${rel} (running)`);
}

