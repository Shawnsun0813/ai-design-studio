// Session manager (W3; W4 adds round decisions, change of direction, round-level cancel and English messages).
// The only place user commands enter. Every command is validated against the fact store (current wait, epoch,
// proposal digest, page version, allowed options); then the decision event is appended and the LangGraph run is
// resumed (Command({resume})) or — after a restart / retry / cancel — started on a fresh thread that re-enters
// from the facts. Cancel / change of direction = epoch bump + AbortController.abort(); late results are refused.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Command, MemorySaver } from '@langchain/langgraph';
import { openStore } from '../runtime/store.mjs';
import { createModel, createStubModel, openLedger, CAPS } from '../runtime/model.mjs';
import { captureEvidence } from '../runtime/evidence.mjs';
import { versionOf } from '../runtime/versions.mjs';
import { buildGraph, digestOf, inRound, LIMITS } from '../graph/session-graph.mjs';
import { stubHandlers } from './stub.mjs';
import { RUNNING } from '../runtime/code-version.mjs';
import { failureOptions, isScopeFailure } from '../runtime/failure.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const OPERATORS = { 'developer-test': 'Developer test', 'owner-trial': 'Owner trial (not a W5 session)' };

class CommandError extends Error { constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; } }

export function createSessionManager({ baseline = null, typeCheck = null, sessionsDir, ledgerFile, stubLedgerFile, exec, registry, projectRoot, targetUrl, cdpPort, modelMode = 'live', onChange, log = console, capture, reachable }) {
  const ledger = openLedger(ledgerFile);
  const stubLedger = openLedger(stubLedgerFile);
  const stubControl = { faults: {}, pmMode: 'adjust' };
  let cur = null; // { store, graph, ctx, model, threadId, controller, running, interrupted, unsub }

  const regionOf = (regionId) => ({ regionId, ...registry.regions[regionId] });
  function allSourceHashes() {
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel); else out[rel] = exec.hashFile(rel);
      }
    };
    walk('src');
    return out;
  }
  async function targetReachable() {
    if (reachable) return reachable();
    try { return (await fetch(targetUrl, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  }

  function attach(store) {
    cur?.unsub?.();
    const p = store.project();
    const mode = p.session?.modelMode || modelMode;
    const model = mode === 'stub'
      ? createStubModel({ ledger: stubLedger, sessionId: store.sessionId, handlers: stubHandlers(stubControl) })
      : createModel({ ledger, sessionId: store.sessionId });
    const c = { store, model, threadId: null, controller: null, running: null, interrupted: false };
    const region = () => regionOf(store.project().region.regionId);
    c.ctx = {
      store, exec, model, projectRoot, targetUrl, counters: null,
      regionId: () => store.project().region?.regionId,
      region,
      version: () => versionOf(exec, region()),
      versionLabel: () => store.project().running?.label ?? 'current',
      allSourceHashes,
      targetReachable,
      signal: () => c.controller?.signal,
      captureEvidence: capture ? (label) => capture(label) : (label) => captureEvidence({ url: `${targetUrl}${registry.page?.path ?? '/'}`, regionId: region().regionId, neighbour: region().neighbour, interaction: region().interaction, cdpPort, label }),
      // Both are optional: a region that only allows CSS has neither, and the graph treats them as absent.
      snapshotBaseline: baseline ? (label) => baseline(label) : null,
      typeCheck: typeCheck ? () => typeCheck() : null,
    };
    c.unsub = store.subscribe(() => onChange?.());
    cur = c;
    onChange?.();
    return c;
  }

  // On startup: reopen the latest session. A task that was running when the process stopped has an unknown outcome:
  // it is marked failed (INTERRUPTED), its unsettled reservation keeps counting at worst case, and the user decides.
  function loadLatest() {
    if (!fs.existsSync(sessionsDir)) return null;
    const ids = fs.readdirSync(sessionsDir).filter((d) => fs.existsSync(path.join(sessionsDir, d, 'events.jsonl'))).sort();
    if (!ids.length) return null;
    const store = openStore(sessionsDir, ids.at(-1));
    const p = store.project();
    const running = p.order.map((id) => p.tasks[id]).filter((t) => t.status === 'running' && t.epoch === p.epoch);
    for (const t of running) {
      const inst = t.instances.at(-1);
      const reserved = inst && (p.session?.modelMode === 'stub' ? stubLedger : ledger).instances((i) => i.instanceId === inst.id)[0];
      if (inst && !inst.endedAt) {
        store.append({ type: 'instance_ended', taskId: t.id, instanceId: inst.id, payload: { status: 'interrupted', code: 'INTERRUPTED', usd: 0, usdUnknown: true } });
        if (inst.model && inst.model !== 'program') store.append({ type: 'cost', taskId: t.id, instanceId: inst.id, payload: { role: t.role, usd: 0, usdUnknown: true, worstUsd: reserved?.reserved || 0 } });
      }
      store.append({ type: 'task_failed', taskId: t.id, epoch: p.epoch, payload: { code: 'INTERRUPTED', reason: 'The studio stopped while this step was running. Its outcome is unknown and nothing from it was written; its cost is counted at the reserved maximum. You can retry this step.', userRetry: true, options: ['retry', 'cancel'] } });
      store.append({ type: 'waiting_user', taskId: t.id, epoch: p.epoch, payload: { kind: 'failure', prompt: 'The studio restarted while this step was running. Retry it?', options: ['retry', 'cancel'] } });
    }
    const c = attach(store);
    // If the session was waiting for the user, re-enter the graph so the wait is a live interrupt again.
    if (store.project().waiting && store.project().waiting.kind !== 'failure') run(null);
    return c;
  }

  function run(resumeSeq) {
    const c = cur;
    if (c.running) return c.running.then(() => (cur === c ? run(resumeSeq) : undefined));
    const p = c.store.project();
    if (!p.brief || p.closed || p.cancelled) return Promise.resolve();
    const graph = c.graph ?? (c.graph = buildGraph(c.ctx, { checkpointer: new MemorySaver() }));
    const resume = resumeSeq != null && c.interrupted && c.threadId;
    if (!resume) c.threadId = `t-${Date.now().toString(36)}`;
    c.controller = new AbortController();
    const config = { configurable: { thread_id: c.threadId }, signal: c.controller.signal, recursionLimit: 400 };
    const input = resume ? new Command({ resume: { seq: resumeSeq } }) : {};
    c.interrupted = false;
    c.running = graph.invoke(input, config)
      .then(async () => {
        const st = await graph.getState({ configurable: { thread_id: c.threadId } });
        c.interrupted = st.tasks.some((t) => t.interrupts?.length);
      })
      .catch((e) => {
        if (e?.name === 'AbortError' || c.controller?.signal.aborted || e?.code === 'ABORTED') return;
        log.error?.('graph run error', e);
        const q = c.store.project();
        c.store.append({ type: 'note', payload: { tone: 'error', code: 'RUN_ERROR', text: `The team's run stopped with an error: ${String(e?.message || e).slice(0, 200)}` } });
        c.store.append({ type: 'task_failed', taskId: q.order.at(-1), epoch: q.epoch, payload: { code: 'RUN_ERROR', reason: String(e?.message || e).slice(0, 200), userRetry: true, options: ['retry', 'cancel'] } });
        if (!c.store.project().waiting) c.store.append({ type: 'waiting_user', taskId: q.order.at(-1), epoch: q.epoch, payload: { kind: 'failure', prompt: 'The run stopped with an error. Retry?', options: ['retry', 'cancel'] } });
      })
      .finally(() => { c.running = null; c.controller = null; onChange?.(); });
    return c.running;
  }

  const need = (cond, code, msg, status) => { if (!cond) throw new CommandError(code, msg, status); };

  function decide(c, p, cmd, payload) {
    const ev = c.store.append({ type: 'decision', payload: { ...payload, waitSeq: cmd.waitSeq, by: p.session.operator } });
    run(cmd.waitSeq);
    return { ok: true, seq: ev.event.seq };
  }

  function imageSize(buf, type) {
    if (type === 'image/png' && buf.length > 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (type === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) break;
        const m = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xc3) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
    return { w: 1600, h: 1200 };
  }

  const waitingFor = (p, kind, cmd, what) => need(p.waiting?.kind === kind && p.waiting.seq === cmd.waitSeq, 'NOT_WAITING', `The team is not waiting for ${what} right now (it may already have been sent).`);

  function command(cmd) {
    if (cmd.type === 'new_session') {
      need(OPERATORS[cmd.operator], 'BAD_OPERATOR', 'Choose who is operating this session.', 400);
      if (cur) need(!cur.running, 'BUSY', 'The current session is still working. Cancel it first.', 409);
      const store = openStore(sessionsDir);
      store.append({ type: 'session_started', payload: { operator: cmd.operator, modelMode, model: modelMode === 'stub' ? 'stub' : 'claude-sonnet-5-5', target: { url: targetUrl, project: registry.project, page: registry.page } } });
      attach(store);
      return { ok: true, sessionId: store.sessionId };
    }
    const c = cur;
    need(c, 'NO_SESSION', 'There is no session yet.', 409);
    const p = c.store.project();
    need(cmd.epoch === p.epoch, 'STALE_EPOCH', `This action was made on an older state of the session (generation ${cmd.epoch}, now ${p.epoch}) and was refused.`);

    switch (cmd.type) {
      case 'select_region': {
        need(['pick-region', 'brief'].includes(p.status), 'BAD_STATE', 'You can no longer change the region in this session.');
        if (!cmd.regionId || !registry.regions[cmd.regionId]) {
          c.store.append({ type: 'note', payload: { tone: 'warn', code: 'REGION_UNREGISTERED', text: `You clicked ${cmd.element || 'an unregistered part of the page'}. It is not a registered region, so the team will not guess where its code is and cannot change it. Pick a registered region.` } });
          return { ok: false, code: 'REGION_UNREGISTERED' };
        }
        const r = registry.regions[cmd.regionId];
        c.store.append({ type: 'region_selected', payload: { regionId: cmd.regionId, component: r.component, sourceFile: r.sourceFile, allowedFiles: r.allowedFiles, preserve: r.preserve, element: cmd.element, label: r.label, mode: r.mode ?? 'six-roles' } });
        return { ok: true };
      }
      case 'brief': {
        need(p.status === 'brief', 'BAD_STATE', 'Pick a region on the page first.');
        const goal = String(cmd.goal || '').trim();
        need(goal.length > 0 && goal.length <= 2000, 'BAD_GOAL', 'Say in a sentence or two what you want to change (up to 2000 characters).', 400);
        let referenceId = null; let referenceName = null;
        if (!cmd.noReference) {
          const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(cmd.reference?.dataUrl || '');
          need(m, 'BAD_REFERENCE', 'The reference must be a PNG or JPEG image — or tick "No reference".', 400);
          const buf = Buffer.from(m[2], 'base64');
          need(buf.length <= 5 * 1024 * 1024, 'BAD_REFERENCE', 'The reference image must be 5 MB or smaller.', 400);
          const { w, h } = imageSize(buf, m[1]);
          const file = c.store.saveBinary(`reference.${m[1] === 'image/png' ? 'png' : 'jpg'}`, buf);
          referenceName = String(cmd.reference.name || 'reference').slice(0, 80);
          referenceId = c.store.saveArtifact('reference', { file, mediaType: m[1], w, h, name: referenceName, sha256: sha(buf) });
        }
        c.store.append({ type: 'user_brief', payload: { goal, referenceId, referenceName, noReference: !!cmd.noReference, by: p.session.operator } });
        run(null);
        return { ok: true };
      }
      case 'confirm_interpretation':
      case 'correct_interpretation': {
        waitingFor(p, 'confirm-interpretation', cmd, 'a confirmation of the interpretation');
        need(cmd.interpretationId === p.latest.interpretation, 'STALE_ARTIFACT', 'This interpretation has been replaced; look at the latest one.');
        if (cmd.type === 'confirm_interpretation') return decide(c, p, cmd, { kind: 'confirm-interpretation', value: cmd.interpretationId });
        const text = String(cmd.text || '').trim();
        need(text, 'BAD_TEXT', 'Write a one-line correction, e.g. "don\'t borrow its colours".', 400);
        const n = p.decisions.filter((d) => d.kind === 'correct-interpretation' && d.epoch === p.epoch).length;
        need(n < LIMITS.correctionsPerRound, 'LIMIT', `You have reached the limit of ${LIMITS.correctionsPerRound} corrections this round. Confirm the current reading or cancel.`);
        return decide(c, p, cmd, { kind: 'correct-interpretation', value: cmd.interpretationId, text });
      }
      case 'choose': {
        waitingFor(p, 'choose', cmd, 'your choice of direction');
        const propsA = inRound(p, 'proposals');
        need(propsA && p.waiting.refs.proposalsId === propsA.id, 'STALE_ARTIFACT', 'These proposals have been replaced.');
        const props = c.store.readArtifact(propsA.id);
        const chosen = props.data.proposals.find((x) => x.id === cmd.proposalId);
        need(chosen, 'BAD_PROPOSAL', 'There is no such proposal.', 400);
        need(cmd.digest === props.digests[chosen.id] && digestOf(chosen) === cmd.digest, 'STALE_PROPOSAL', 'The proposal is not the one you saw; the choice was refused.');
        // A direction this area cannot build is not a choice. (It only happens with rounds proposed before the
        // capability check existed; the refusal arrives here instead of after a full round of work.)
        const blocked = p.waiting.refs?.blocked?.[chosen.id];
        need(!blocked, 'DIRECTION_NOT_POSSIBLE', `${blocked} This direction cannot be built in this area, so it is not offered.`);
        const now = versionOf(exec, regionOf(p.region.regionId));
        if (now.hash !== props.baseVersion.hash) {
          c.store.append({ type: 'note', payload: { tone: 'error', code: 'STALE_PROPOSAL', text: `The page changed after these proposals were made (${props.baseVersion.short} → ${now.short}). They are out of date and cannot authorize a change. Cancel this round and start again.` } });
          throw new CommandError('STALE_PROPOSAL', 'The page changed after the proposals were made; they are out of date.');
        }
        return decide(c, p, cmd, { kind: 'choose', value: chosen.id, digest: cmd.digest, modification: String(cmd.modification || '').trim().slice(0, 1000), refs: { proposalsId: props.id, baseHash: props.baseVersion.hash } });
      }
      case 'reject': {
        waitingFor(p, 'choose', cmd, 'your choice of direction');
        const reason = String(cmd.reason || '').trim();
        need(reason, 'BAD_TEXT', 'Say why none of them works; the creative lead will propose again from that.', 400);
        const start = p.roundStarts[p.round]?.seq ?? 0;
        const n = p.decisions.filter((d) => d.kind === 'reject' && d.round === p.round && d.seq > start).length;
        need(n < LIMITS.rejectsPerRound, 'LIMIT', `You have turned down proposals ${n} times this round (limit ${LIMITS.rejectsPerRound}). Choose one (you can add changes) or cancel the round.`);
        return decide(c, p, cmd, { kind: 'reject', value: inRound(p, 'proposals').id, reason });
      }
      case 'round_decision': {
        waitingFor(p, 'round-decision', cmd, 'your decision on this round');
        const opts = p.waiting.options;
        const v = cmd.value;
        if (v === 'restore') need(opts.includes(`restore:${cmd.target}`), 'BAD_TARGET', `There is no ${cmd.target} version to restore to right now.`);
        else need(opts.includes(v), v === 'rework' ? 'LIMIT' : 'BAD_VALUE', v === 'rework' ? `A fix can be started once per round, from a review (limit ${LIMITS.fixesPerRound}).` : 'That option is not available now.');
        const text = String(cmd.text || '').trim();
        if (v === 'feedback') need(text, 'BAD_TEXT', 'Say what to change and what to keep.', 400);
        if (v === 'adopt') {
          const now = versionOf(exec, regionOf(p.region.regionId));
          need(now.hash === p.running.hash, 'ADOPT_CONFLICT', `The file changed outside the studio, so the page is no longer ${p.running.label}. Nothing was adopted.`);
        }
        return decide(c, p, cmd, { kind: 'round-decision', value: v, target: cmd.target, text: text || undefined, refs: { running: p.running?.label, runningHash: p.running?.hash } });
      }
      case 'redirect': {
        // Change direction while the team works: the in-flight work becomes stale and a new round starts from the
        // current page with the new feedback. Only before this round's change is written.
        const text = String(cmd.text || '').trim();
        need(text, 'BAD_TEXT', 'Say what you want instead.', 400);
        need(p.busy && !p.waiting, 'BAD_STATE', 'You can change direction while the team is working. Otherwise use "Continue refining".');
        const hand = inRound(p, 'handoff');
        need(hand, 'BAD_STATE', 'Choose a direction first; to change the reading of your reference use the correction box.');
        need(!p.applies.some((a) => a.round === p.round && a.seq > hand.seq), 'ALREADY_WRITTEN', 'This round\'s change is already written. Wait for the review, then continue refining or restore.');
        c.store.append({ type: 'epoch_bumped', payload: { from: p.epoch, to: p.epoch + 1, reason: 'redirect', note: 'You changed direction', by: p.session.operator } });
        c.controller?.abort();
        c.store.append({ type: 'decision', payload: { kind: 'round-decision', value: 'feedback', text, redirect: true, by: p.session.operator } });
        run(null);
        return { ok: true };
      }
      case 'retry': {
        waitingFor(p, 'failure', cmd, 'a decision on a failed step');
        const fv = failureView(c, p);
        need(!fv?.impossible, 'DIRECTION_NOT_POSSIBLE', 'Running this step again cannot help: the direction you chose cannot be built in this area. Pick a different direction if one is offered, or end this round.');
        need(fv?.retryable || p.failure?.code === 'SELECTOR_NOT_ALLOWED', 'NOT_RETRYABLE', 'This kind of failure cannot be retried (for example: budget limit, or the page changed). Cancel the round instead.');
        return decide(c, p, cmd, { kind: 'retry', value: p.failure.taskId });
      }
      case 'choose_again': {
        // After a direction turned out to be undeliverable: the earlier choice and what came from it stop counting,
        // the directions the team already produced stay, and no model is called again. History is not rewritten.
        waitingFor(p, 'failure', cmd, 'a decision on a failed step');
        const view = failureView(c, p);
        need(view?.options?.includes('choose_again'), 'BAD_STATE', view?.impossible
          ? 'None of the directions offered in this round can be built in this area, so there is nothing to switch to. End this round instead.'
          : 'There is no other direction to pick for this step.');
        const props = inRound(p, 'proposals');
        need(props, 'BAD_STATE', 'The directions of this round are no longer available; cancel the round instead.');
        const chosen = p.decisions.filter((d) => d.kind === 'choose' && d.round === p.round).at(-1);
        return decide(c, p, cmd, { kind: 'choose-again', value: chosen?.value, reason: String(cmd.reason || p.failure?.code || 'out of scope').slice(0, 300), refs: { proposalsId: props.id } });
      }
      case 'acknowledge': {
        waitingFor(p, 'failure', cmd, 'an acknowledgement');
        need(p.failure?.options?.includes('acknowledge'), 'BAD_STATE', 'This failure needs a retry or a cancel.');
        return decide(c, p, cmd, { kind: 'acknowledge', value: p.failure.code });
      }
      case 'cancel': {
        need(p.session && !p.closed && !p.cancelled && p.brief, 'BAD_STATE', 'There is no round to cancel.');
        need(p.busy || ['failure', 'confirm-interpretation', 'choose'].includes(p.waiting?.kind), 'BAD_STATE', 'Nothing is running. Use the options below to decide what happens next.');
        c.store.append({ type: 'epoch_bumped', payload: { from: p.epoch, to: p.epoch + 1, reason: 'cancel', note: 'You cancelled this round', by: p.session.operator } });
        c.controller?.abort();
        run(null);
        return { ok: true };
      }
      default:
        throw new CommandError('UNKNOWN_COMMAND', `unknown command ${cmd.type}`, 400);
    }
  }

  // Gathers the facts `failureOptions` needs (the round's directions, the region, the choice in effect).
  function failureView(c, p) {
    if (!p.failure || !isScopeFailure(p.failure)) return p.failure ?? null;
    const ref = p.region && inRound(p, 'proposals');
    if (!ref) return p.failure;
    let proposals;
    try { proposals = c.store.readArtifact(ref.id).data.proposals; } catch { return p.failure; }
    return failureOptions({
      failure: p.failure,
      proposals,
      region: regionOf(p.region.regionId),
      chosenId: p.decisions.filter((d) => d.kind === 'choose' && d.round === p.round && d.epoch === p.epoch && !d.superseded).at(-1)?.value,
    });
  }

  function snapshot() {
    if (!cur) return { session: null, ledger: { tranche: ledger.summary() }, caps: CAPS, modelMode, operators: OPERATORS, code: RUNNING };
    const p = cur.store.project();
    const artifacts = {};
    for (const id of Object.keys(p.artifacts)) artifacts[id] = cur.store.readArtifact(id);
    if (p.brief?.referenceId) artifacts[p.brief.referenceId] = cur.store.readArtifact(p.brief.referenceId);
    const led = p.session?.modelMode === 'stub' ? stubLedger : ledger;
    const pageVersion = p.region ? versionOf(exec, regionOf(p.region.regionId)) : null;
    return {
      sessionId: cur.store.sessionId,
      state: { ...p, failure: failureView(cur, p) },
      events: cur.store.events(),
      artifacts,
      pageVersion,
      running: !!cur.running,
      ledger: { tranche: ledger.summary(), session: led.summary((i) => i.sessionId === cur.store.sessionId) },
      caps: CAPS,
      limits: LIMITS,
      modelMode: p.session?.modelMode || modelMode,
      operators: OPERATORS,
      code: RUNNING,
    };
  }

  return {
    loadLatest,
    command: (cmd) => {
      try { return command(cmd); } catch (e) { if (e instanceof CommandError) return { ok: false, code: e.code, message: e.message, status: e.status }; throw e; }
    },
    snapshot,
    current: () => cur,
    stubControl,
    binaryPath: (sessionId, name) => (cur && cur.store.sessionId === sessionId ? cur.store.binaryPath(name) : (/^[\w-]+$/.test(sessionId) && /^[\w.-]+$/.test(name) ? path.join(sessionsDir, sessionId, 'artifacts', name) : null)),
    idle: () => cur?.running ?? Promise.resolve(),
  };
}
