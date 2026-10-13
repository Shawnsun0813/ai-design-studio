// Session fact store (W3, extended in W4 with rounds, adoption and restore): append-only events.jsonl + artifacts/
// + a pure projection. Single source of truth for session facts (P02-M02 / P02-M05). Orchestration state only holds
// references; file versions come from disk hashes.
// Based on the W2 store: results produced under an old epoch are refused here (recorded as `stale`).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Event types whose payload is a *result* of work; they must carry the epoch they were produced under.
const RESULT_TYPES = new Set(['artifact_created', 'instance_finished', 'applied', 'review_passed', 'review_returned', 'waiting_user', 'task_failed', 'tech_check', 'adopted', 'restored', 'restore_failed', 'round_started', 'session_closed']);

export function openStore(dir, sessionId = `s-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`) {
  const sdir = path.join(dir, sessionId);
  fs.mkdirSync(path.join(sdir, 'artifacts'), { recursive: true });
  const file = path.join(sdir, 'events.jsonl');
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  let cache = read();
  let state = project(cache);
  const listeners = new Set();

  function write(ev) {
    const full = { seq: cache.length + 1, ts: new Date().toISOString(), sessionId, ...ev };
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
    cache.push(full);
    state = project(cache);
    for (const f of listeners) f(full);
    return full;
  }

  // Append an event. Result events from a stale epoch are not applied: a `stale` event is written instead.
  function append(ev) {
    if (RESULT_TYPES.has(ev.type) && ev.epoch !== state.epoch) {
      write({ type: 'stale', round: state.round, epoch: state.epoch, taskId: ev.taskId, payload: { rejectedType: ev.type, eventEpoch: ev.epoch, currentEpoch: state.epoch } });
      return { accepted: false, reason: 'STALE_EPOCH' };
    }
    return { accepted: true, event: write({ round: state.round, epoch: state.epoch, ...ev }) };
  }

  function saveArtifact(kind, data, meta = {}) {
    const id = `${kind}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(path.join(sdir, 'artifacts', `${id}.json`), JSON.stringify({ id, kind, createdAt: new Date().toISOString(), ...meta, data }, null, 2));
    return id;
  }
  function saveBinary(name, buf) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`bad artifact file name ${name}`);
    fs.writeFileSync(path.join(sdir, 'artifacts', name), buf);
    return name;
  }
  const readArtifact = (id) => JSON.parse(fs.readFileSync(path.join(sdir, 'artifacts', `${id}.json`), 'utf8'));
  const binaryPath = (name) => (/^[\w.-]+$/.test(name) ? path.join(sdir, 'artifacts', name) : null);

  return {
    sessionId,
    dir: sdir,
    append,
    saveArtifact,
    saveBinary,
    readArtifact,
    binaryPath,
    events: () => cache.slice(),
    project: () => state,
    subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); },
  };
}

export const ACTIVE = ['waiting_dep', 'running', 'waiting_user'];

// Pure projection: same events → same state. Used by the UI, by orchestration routing and after restarts.
// W4: per-round facts (applies, reviews, round starts, cancels), version labels, adoption and restore records.
// `anchor` = seq of the latest state-changing fact; a round-decision wait is recorded once per anchor.
export function project(events) {
  const s = {
    session: null, region: null, brief: null, round: 1, epoch: 0,
    tasks: {}, order: [], decisions: [], versions: [], artifacts: {}, waiting: null,
    interpretations: [], latest: {}, waitLog: [], applies: [], reviews: [], techChecks: [], roundStarts: {}, cancels: [],
    adoptions: [], restores: [], restoreFailures: [], running: null, adopted: null,
    closed: null, failure: null, notes: [], anchor: 0,
    cost: { knownUsd: 0, calls: 0, unknownCalls: 0, unknownWorstUsd: 0 }, stale: 0, last: 0,
  };
  const task = (id) => s.tasks[id];
  for (const e of events) {
    s.last = e.seq;
    const p = e.payload || {};
    switch (e.type) {
      case 'session_started': s.session = { id: e.sessionId, operator: p.operator, modelMode: p.modelMode, model: p.model, startedAt: e.ts, target: p.target }; break;
      case 'region_selected': s.region = { regionId: p.regionId, component: p.component, sourceFile: p.sourceFile, allowedFiles: p.allowedFiles, preserve: p.preserve, element: p.element, label: p.label, mode: p.mode ?? 'six-roles' }; break;
      case 'user_brief':
        s.brief = { goal: p.goal, referenceId: p.referenceId, referenceName: p.referenceName, noReference: !!p.noReference, seq: e.seq };
        s.roundStarts[1] = { seq: e.seq, feedback: p.goal };
        break;
      case 'round_started':
        s.round = p.round;
        s.roundStarts[p.round] = { seq: e.seq, feedback: p.feedback, fromDecision: p.fromDecision, base: p.base, redirect: !!p.redirect };
        s.anchor = e.seq;
        break;
      case 'epoch_bumped': {
        s.epoch = p.to;
        for (const t of Object.values(s.tasks)) {
          if (t.epoch < s.epoch && ACTIVE.includes(t.status)) { t.status = p.reason === 'cancel' ? 'cancelled' : 'stale'; t.action = p.note; }
        }
        if (s.waiting && s.waiting.epoch < s.epoch) s.waiting = null;
        s.cancels.push({ seq: e.seq, round: s.round, reason: p.reason, note: p.note, by: p.by, ts: e.ts });
        s.failure = null;
        s.anchor = e.seq;
        break;
      }
      case 'task_created':
        s.tasks[e.taskId] = {
          id: e.taskId, role: e.role, node: p.node, title: p.title, kind: p.kind, status: p.waitingFor ? 'waiting_dep' : 'running',
          action: p.action, round: e.round, epoch: e.epoch, region: e.regionId, version: e.version,
          inputs: p.inputs || [], artifacts: [], instances: [], createdAt: e.ts, attempts: 0,
        };
        s.order.push(e.taskId);
        if (s.failure && s.failure.node === p.node) s.failure = null;
        break;
      case 'instance_started':
        if (task(e.taskId)) {
          const t = task(e.taskId);
          t.status = 'running'; t.action = p.action; t.startedAt = e.ts; t.attempts += 1;
          t.instances.push({ id: e.instanceId, model: p.model, promptVersion: p.promptVersion, attempt: p.attempt, startedAt: e.ts });
        }
        break;
      case 'instance_ended': {
        const t = task(e.taskId);
        const i = t?.instances.find((x) => x.id === e.instanceId);
        if (i) Object.assign(i, { endedAt: e.ts, status: p.status, usd: p.usd, usdUnknown: p.usdUnknown, usage: p.usage, ms: p.ms, code: p.code });
        break;
      }
      case 'progress': if (task(e.taskId) && ACTIVE.includes(task(e.taskId).status)) task(e.taskId).action = p.text; break;
      case 'artifact_created': {
        s.artifacts[p.id] = { id: p.id, kind: p.kind, taskId: e.taskId, round: e.round, epoch: e.epoch, version: e.version, title: p.title, seq: e.seq, mode: p.mode, cycle: p.cycle };
        task(e.taskId)?.artifacts.push(p.id);
        if (p.kind === 'interpretation') {
          for (const x of s.interpretations) x.stale = true;
          s.interpretations.push({ id: p.id, version: s.interpretations.length + 1, stale: false, confirmed: false, round: e.round });
        }
        s.latest[p.kind] = p.id;
        if (p.kind === 'review') s.anchor = e.seq;
        break;
      }
      case 'instance_finished':
        if (task(e.taskId)) { const t = task(e.taskId); t.status = 'done'; t.action = p.summary; t.handoffTo = p.handoffTo; t.endedAt = e.ts; }
        break;
      case 'waiting_user':
        s.waiting = { seq: e.seq, taskId: e.taskId, kind: p.kind, prompt: p.prompt, options: p.options, refs: p.refs || {}, epoch: e.epoch };
        s.waitLog.push({ seq: e.seq, kind: p.kind, epoch: e.epoch });
        if (task(e.taskId) && p.kind !== 'failure') { task(e.taskId).status = 'waiting_user'; task(e.taskId).action = p.prompt; }
        break;
      case 'decision': {
        s.decisions.push({ seq: e.seq, kind: p.kind, value: p.value, target: p.target, digest: p.digest, modification: p.modification, reason: p.reason, text: p.text, by: p.by, round: e.round, epoch: e.epoch, waitSeq: p.waitSeq, refs: p.refs, redirect: !!p.redirect });
        if (p.kind === 'confirm-interpretation') { const it = s.interpretations.find((x) => x.id === p.value); if (it) it.confirmed = true; }
        if (s.waiting && s.waiting.seq === p.waitSeq) {
          const w = task(s.waiting.taskId);
          if (w && w.status === 'waiting_user') { w.status = 'done'; w.action = DECIDED[p.kind] || 'You decided'; }
          s.waiting = null;
        }
        if (p.kind === 'retry' || p.kind === 'acknowledge' || p.kind === 'choose-again') s.failure = null;
        if (p.kind === 'choose-again') {
          // the earlier choice and the work derived from it stop counting; the events stay as they are
          for (const d of s.decisions) if (d.kind === 'choose' && d.round === e.round && d.epoch === e.epoch) d.superseded = true;
          for (const id of Object.keys(s.artifacts)) {
            const a = s.artifacts[id];
            if (a.round === e.round && a.epoch === e.epoch && ['spec', 'handoff', 'patch'].includes(a.kind) && a.seq < e.seq) a.superseded = true;
          }
          for (const id of s.order) {
            const t = s.tasks[id];
            if (t.round === e.round && t.epoch === e.epoch && ['refine', 'handoff', 'implement'].includes(t.node)) { t.status = 'stale'; t.action = 'Replaced: you picked a different direction'; }
          }
        }
        break;
      }
      case 'review_returned':
      case 'review_passed': {
        const pass = e.type === 'review_passed';
        if (task(e.taskId)) { task(e.taskId).reviewPassed = pass; if (!pass) { task(e.taskId).status = 'returned'; task(e.taskId).returnReason = p.reasons; } }
        s.reviews.push({ seq: e.seq, round: e.round, epoch: e.epoch, id: p.id, pass, taskId: e.taskId, cycle: p.cycle });
        break;
      }
      case 'tech_check': s.techChecks.push({ seq: e.seq, round: e.round, ok: p.ok, items: p.items, taskId: e.taskId }); break;
      case 'task_failed':
        if (task(e.taskId)) { const t = task(e.taskId); t.status = 'failed'; t.action = p.reason; t.code = p.code; t.endedAt = e.ts; }
        // A refusal by the selector scope never wrote anything and leaves the chosen patch intact, so it can be
        // retried even if it was recorded before that was true (the events themselves are not rewritten).
        {
          // Same reasoning for "pick a different direction": the failure is about what this region can carry, the
          // round still has the directions the team produced, and nothing was written — so the way out holds for
          // failures recorded before it existed. Derived here; the events stay as they were written.
          let options = p.options ?? [];
          const aboutScope = ['SELECTOR_NOT_ALLOWED', 'OUTPUT_INVALID'].includes(p.code) && /outside this region|cannot add|only exists in the preview|@keyframes|animation/i.test(String(p.reason));
          const directions = Object.values(s.artifacts).filter((a) => a.kind === 'proposals' && a.round === e.round && a.epoch === e.epoch).at(-1);
          if (aboutScope && directions && !options.includes('choose_again')) options = [...options.filter((o) => o !== 'cancel'), 'choose_again', ...(options.includes('cancel') ? ['cancel'] : [])];
          s.failure = { taskId: e.taskId, node: task(e.taskId)?.node, code: p.code, reason: p.reason, retryable: !!p.userRetry || p.code === 'SELECTOR_NOT_ALLOWED', seq: e.seq, options };
        }
        break;
      case 'version_observed': {
        const v = { label: p.label, kind: p.kind, files: p.files, hash: p.hash, all: p.all, round: e.round, seq: e.seq, ts: e.ts, snapshot: p.snapshot };
        s.versions.push(v);
        s.running = v;
        break;
      }
      case 'applied':
        s.applies.push({ seq: e.seq, round: e.round, epoch: e.epoch, taskId: e.taskId, execTaskId: p.execTaskId, before: p.before, after: p.after, diffId: p.diffId, cycle: p.cycle });
        s.anchor = e.seq;
        break;
      case 'adopted': {
        const a = { seq: e.seq, label: p.label, hash: p.hash, files: p.files, regionId: p.regionId, by: p.by, decisionSeq: p.decisionSeq, round: e.round, ts: e.ts };
        s.adoptions.push(a);
        s.adopted = a;
        s.anchor = e.seq;
        break;
      }
      case 'restored': s.restores.push({ seq: e.seq, decisionSeq: p.decisionSeq, target: p.target, label: p.label, to: p.to, execTaskId: p.execTaskId, round: e.round, ts: e.ts }); s.anchor = e.seq; break;
      case 'restore_failed': s.restoreFailures.push({ seq: e.seq, decisionSeq: p.decisionSeq, code: p.code, reason: p.reason }); s.anchor = e.seq; break;
      case 'round_closed': // W3 sessions
      case 'session_closed': s.closed = { outcome: p.outcome, seq: e.seq, ts: e.ts }; break;
      case 'cost':
        s.cost.calls += 1;
        if (p.usdUnknown) { s.cost.unknownCalls += 1; s.cost.unknownWorstUsd += p.worstUsd || 0; } else s.cost.knownUsd += p.usd || 0;
        break;
      case 'note': s.notes.push({ seq: e.seq, tone: p.tone, text: p.text, code: p.code }); break;
      case 'stale': s.stale += 1; break;
      default: break;
    }
  }
  s.cost.knownUsd = Math.round(s.cost.knownUsd * 1e6) / 1e6;
  s.cost.unknownWorstUsd = Math.round(s.cost.unknownWorstUsd * 1e6) / 1e6;
  // Shortcuts used by the UI.
  s.applied = s.applies.at(-1) ?? null;
  s.review = s.reviews.at(-1) ?? null;
  s.techCheck = s.techChecks.at(-1) ?? null;
  s.restored = s.restores.at(-1) ?? null;
  const lastCancel = s.cancels.at(-1);
  // A cancel is terminal only when nothing was ever written or adopted in this session.
  s.cancelled = lastCancel && lastCancel.round === s.round && lastCancel.reason === 'cancel' && !s.applies.length && !s.adopted ? lastCancel : null;
  s.running = s.running ?? null;
  s.busy = s.order.some((id) => s.tasks[id].status === 'running');
  s.status = s.closed ? 'closed' : s.cancelled ? 'cancelled' : s.waiting ? (s.waiting.kind === 'failure' ? 'failed' : 'waiting') : s.busy ? 'running' : s.brief ? 'idle' : s.region ? 'brief' : s.session ? 'pick-region' : 'none';
  return s;
}

const DECIDED = {
  'choose-again': 'You asked for a different direction',
  'confirm-interpretation': 'You confirmed the interpretation',
  'correct-interpretation': 'You corrected the interpretation',
  choose: 'You chose a direction',
  reject: 'You turned down these directions',
  'round-decision': 'You decided what to do next',
  'round-end': 'You decided on this round',
};

// Team-view projection: exactly what a task card needs, derived from facts.
export function teamView(state) {
  return state.order.map((id) => {
    const t = state.tasks[id];
    return { id, role: t.role, node: t.node, title: t.title, status: t.status, action: t.action, round: t.round, epoch: t.epoch, region: t.region, version: t.version, artifacts: t.artifacts, handoffTo: t.handoffTo, returnReason: t.returnReason, instances: t.instances.length, startedAt: t.startedAt, endedAt: t.endedAt };
  });
}
