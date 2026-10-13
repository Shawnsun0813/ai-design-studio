// Session graph (LangGraph JS 1.4.21; W3 shape, extended in W4 with rounds, adoption, restore and a user-started fix).
// Shape: START → router ⇄ nodes. `router` is a program node that derives the next step from the session fact store,
// so a resume, a user retry or a restart (fresh MemorySaver, new thread) all re-enter at the right node without
// re-running finished work. Graph state = references + routing only; facts live in the store; file versions are
// disk hashes; writes go only through the Phase01 executor. Models produce artifacts; they never decide transitions.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Annotation, StateGraph, START, END, interrupt, MemorySaver } from '@langchain/langgraph';
import * as roles from '../runtime/roles.mjs';
import { imageBlock } from '../runtime/model.mjs';
import { persistEvidence } from '../runtime/evidence.mjs';
import { observeVersion, restoreTargets, restoreTo, diffSnapshots } from '../runtime/versions.mjs';
import { checkPatchScope, selectorTargetsRegion } from '../runtime/css-scope.mjs';
import { capabilityText, outOfScopeNote, checkProposal, blockedProposals } from '../runtime/capabilities.mjs';

export const LIMITS = {
  attemptsPerTask: 2, // first attempt + at most one automatic retry (known API rejection) or one format repair
  autoRework: 0, // no automatic design rework; the user may start one fix per round from the review
  fixesPerRound: 1, // user-started "fix → evidence → re-review" cycles per round
  rejectsPerRound: 2,
  correctionsPerRound: 2,
};

const keep = (_, b) => b;
export const GraphState = Annotation.Root({
  round: Annotation({ reducer: keep, default: () => 1 }),
  epoch: Annotation({ reducer: keep, default: () => 0 }),
  route: Annotation({ reducer: keep, default: () => null }),
  refs: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
});

export const digestOf = (obj) => `sha256:${createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16)}`;

// ---------- routing from facts ----------
const after = (p, kind, seq) => p.decisions.filter((d) => d.seq > seq && d.kind === kind).at(-1);
// Latest artifact of `kind` produced in the current round and epoch (optionally after `since`).
export const inRound = (p, kind, since = 0) => Object.values(p.artifacts).filter((a) => a.kind === kind && a.round === p.round && a.epoch === p.epoch && a.seq > since).sort((a, b) => a.seq - b.seq).at(-1) ?? null;
// Latest handoff of an earlier round, preferring one that was actually written (what is on the page).
export const inheritedHandoff = (p) => {
  const hs = Object.values(p.artifacts).filter((a) => a.kind === 'handoff' && a.round < p.round).sort((a, b) => a.seq - b.seq);
  return [...hs].reverse().find((h) => p.applies.some((x) => x.round === h.round && x.seq > h.seq)) ?? hs.at(-1) ?? null;
};
// The user asked to pick a different direction after one turned out to be undeliverable: the earlier choice and
// everything derived from it stop counting, but nothing is deleted and no model is called again.
export const chooseAgainSeq = (p) => p.decisions.filter((d) => d.kind === 'choose-again' && d.round === p.round && d.epoch === p.epoch).at(-1)?.seq ?? 0;
export const fixDecision = (p, sinceSeq) => p.decisions.filter((d) => d.kind === 'round-decision' && d.value === 'rework' && d.round === p.round && d.seq > sinceSeq).at(-1);

function decisionStep(p, since) {
  const d = p.decisions.filter((x) => x.kind === 'round-decision' && x.seq > since && x.value !== 'rework').at(-1);
  if (!d) return 'await_round_decision';
  if (d.value === 'adopt') return p.adoptions.some((a) => a.decisionSeq === d.seq) ? 'await_round_decision' : 'adopt';
  if (d.value === 'restore') return p.restores.some((x) => x.decisionSeq === d.seq) || p.restoreFailures.some((x) => x.decisionSeq === d.seq) ? 'await_round_decision' : 'restore_version';
  if (d.value === 'feedback') return 'start_round';
  if (d.value === 'finish') return 'close_session';
  return 'await_round_decision';
}

export function nextNode(p) {
  if (!p.brief || p.closed) return END;
  if (p.waiting) return p.waiting.kind === 'failure' ? END : WAIT_NODE[p.waiting.kind] ?? END;
  if (p.failure) return END;
  const r = p.round;
  const start = p.roundStarts[r]?.seq ?? p.brief.seq;
  const stop = p.cancels.filter((c) => c.round === r && c.seq > start).at(-1);
  if (stop) {
    if (stop.reason === 'cancel' && !p.applies.length && !p.adopted) return END; // nothing on the page to decide about
    return decisionStep(p, stop.seq);
  }
  if (!inRound(p, 'evidence-before')) return 'intake';
  // M1 (D-028): one call does understanding, design and patch, so there is no interpretation gate and no
  // choice of directions — the user sees the change on the page and decides there. The write, the evidence
  // and the round decision are the same steps as always.
  if (p.region?.mode === 'single-call') {
    const build = inRound(p, 'build');
    if (!build) return 'build';
    const ap = p.applies.find((a) => a.round === r && a.epoch === p.epoch && a.seq > build.seq);
    if (!ap) return 'apply';
    if (!inRound(p, 'evidence-after', ap.seq)) return 'evidence';
    return decisionStep(p, inRound(p, 'evidence-after', ap.seq).seq);
  }
  const pm = inRound(p, 'pm-plan');
  if (!pm) return 'pm_brief';
  if (r === 1) {
    const interp = inRound(p, 'interpretation');
    if (!interp || after(p, 'correct-interpretation', interp.seq)) return 'interpret';
    if (!after(p, 'confirm-interpretation', interp.seq)) return 'await_interpretation';
  }
  const again = chooseAgainSeq(p);
  if (r === 1 || pm.mode === 'new-direction') {
    const props = inRound(p, 'proposals');
    if (!props || after(p, 'reject', props.seq)) return 'propose';
    if (!after(p, 'choose', Math.max(props.seq, again))) return 'await_choice';
  }
  if (!inRound(p, 'spec', again)) return 'refine';
  const hand = inRound(p, 'handoff', again);
  if (!hand) return 'handoff';
  const fix = fixDecision(p, hand.seq);
  const cycleStart = fix ? fix.seq : hand.seq;
  if (!inRound(p, 'patch', cycleStart)) return 'implement';
  const ap = p.applies.find((a) => a.round === r && a.epoch === p.epoch && a.seq > cycleStart);
  if (!ap) return 'apply';
  if (!inRound(p, 'evidence-after', ap.seq)) return 'evidence';
  const rev = inRound(p, 'review', ap.seq);
  if (!rev) return 'review';
  return decisionStep(p, rev.seq);
}
const WAIT_NODE = { 'confirm-interpretation': 'await_interpretation', choose: 'await_choice', 'round-decision': 'await_round_decision' };
const NODES = ['intake', 'build', 'pm_brief', 'interpret', 'await_interpretation', 'propose', 'await_choice', 'refine', 'handoff', 'implement', 'apply', 'evidence', 'review', 'await_round_decision', 'adopt', 'restore_version', 'start_round', 'close_session'];

// Options the user has at the end of a round (or after a cancel), derived from facts.
export function roundOptions(p) {
  const r = p.round;
  const opts = [];
  if (p.running && p.adopted?.hash !== p.running.hash) opts.push('adopt');
  opts.push('feedback');
  const start = p.roundStarts[r]?.seq ?? p.brief?.seq ?? 0;
  const stopped = p.cancels.some((c) => c.round === r && c.seq > start);
  const lastReview = p.reviews.filter((x) => x.round === r && x.epoch === p.epoch).at(-1);
  const fixes = p.decisions.filter((d) => d.kind === 'round-decision' && d.value === 'rework' && d.round === r).length;
  if (!stopped && lastReview && fixes < LIMITS.fixesPerRound) opts.push('rework');
  for (const t of Object.keys(restoreTargets(p))) opts.push(`restore:${t}`);
  opts.push('finish');
  return opts;
}

// ---------- helpers ----------
let taskSeq = 0;
const newTaskId = (node, state) => `${node}-r${state.round}-e${state.epoch}-${Date.now().toString(36)}${(++taskSeq).toString(36)}`;
const abortedError = () => Object.assign(new Error('run aborted'), { name: 'AbortError', code: 'ABORTED' });

// The directions of this round: the one in effect, and the others that pass today's capability check. Older
// rounds were produced before that check existed, so "an alternative exists" has to be asked, not assumed.
function directionsNow(ctx) {
  const p = ctx.store.project();
  const ref = inRound(p, 'proposals');
  if (!ref) return { chosen: null, alternatives: [] };
  const proposals = ctx.store.readArtifact(ref.id).data.proposals;
  const choice = after(p, 'choose', ref.seq);
  const chosen = choice ? proposals.find((x) => x.id === choice.value) ?? null : null;
  const region = ctx.region?.() ?? null;
  const alternatives = region
    ? proposals.filter((x) => x.id !== chosen?.id && checkProposal({ proposal: x, region }).length === 0)
    : proposals.filter((x) => x.id !== chosen?.id);
  return { chosen, alternatives };
}

function failTask(ctx, state, taskId, { code, reason, userRetry, options, canChooseAgain }) {
  const opts = options || [...(userRetry ? ['retry'] : []), ...(canChooseAgain ? ['choose_again'] : []), 'cancel'];
  ctx.store.append({ type: 'task_failed', taskId, epoch: state.epoch, payload: { code, reason, userRetry, options: opts } });
  ctx.store.append({ type: 'waiting_user', taskId, epoch: state.epoch, payload: { kind: 'failure', prompt: reason, options: opts } });
  return { route: 'failed' };
}

// A model-backed responsibility: task → instance(s) → artifact (epoch-checked) → finished. At most one automatic
// retry (known API rejection) or one format repair; a request with unknown outcome is not re-sent.
async function roleTask(ctx, state, { node, role, method, title, inputs, kind, handoffTo, build, summarize, artifactMeta, eventExtra }) {
  const { store } = ctx;
  const taskId = newTaskId(node, state);
  store.append({ type: 'task_created', taskId, role, regionId: ctx.regionId(), version: ctx.versionLabel(), payload: { node, title, inputs, action: title } });
  let repair = null;
  for (let attempt = 1; attempt <= LIMITS.attemptsPerTask; attempt++) {
    if (ctx.signal()?.aborted) throw abortedError();
    const instanceId = `i-${role}-${Date.now().toString(36)}${attempt}`;
    store.append({ type: 'instance_started', taskId, instanceId, role, payload: { action: attempt === 1 ? `${title} · waiting for the model` : `Second attempt (${repair ? 'format repair' : 'automatic retry'}) · waiting for the model`, model: ctx.model.model, promptVersion: method.promptVersion, attempt } });
    let req;
    try {
      req = await build(repair);
    } catch (e) {
      store.append({ type: 'instance_ended', taskId, instanceId, payload: { status: 'error', code: 'INPUT_ERROR', usd: 0 } });
      return { ...failTask(ctx, state, taskId, { code: 'INPUT_ERROR', reason: `Could not prepare the input: ${String(e.message).slice(0, 160)}`, userRetry: true }), taskId };
    }
    try {
      const r = await ctx.model.call({ role, promptVersion: method.promptVersion, system: method.system, schema: method.schema, signal: ctx.signal(), instanceId, ...req });
      store.append({ type: 'instance_ended', taskId, instanceId, payload: { status: 'ok', usd: r.usd, usdUnknown: false, usage: r.usage, ms: r.ms } });
      store.append({ type: 'cost', taskId, instanceId, payload: { role, usd: r.usd, usdUnknown: false } });
      const meta = artifactMeta ? artifactMeta(r.output) : {};
      const id = store.saveArtifact(kind, r.output, { role, promptVersion: method.promptVersion, instanceId, model: r.model, inputs, taskId, round: state.round, ...meta });
      const acc = store.append({ type: 'artifact_created', taskId, epoch: state.epoch, payload: { id, kind, title, ...(eventExtra ? eventExtra(r.output) : {}) } });
      if (!acc.accepted) throw abortedError();
      store.append({ type: 'instance_finished', taskId, epoch: state.epoch, payload: { handoffTo, summary: summarize ? summarize(r.output) : undefined } });
      return { id, output: r.output, taskId };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const sent = e.code !== 'BUDGET_EXCEEDED';
      store.append({ type: 'instance_ended', taskId, instanceId, payload: { status: e.code === 'ABORTED' ? 'aborted' : 'failed', code: e.code, usd: e.usd ?? 0, usdUnknown: !!e.usdUnknown, usage: e.usage, ms: e.ms } });
      if (sent) store.append({ type: 'cost', taskId, instanceId, payload: { role, usd: e.usd ?? 0, usdUnknown: !!e.usdUnknown, worstUsd: e.worstUsd } });
      if (e.code === 'ABORTED' || ctx.signal()?.aborted) throw abortedError();
      if (attempt < LIMITS.attemptsPerTask && e.repairable) {
        repair = e.problems;
        store.append({ type: 'progress', taskId, payload: { text: `The output did not pass the program's checks; one format repair (${String(e.problems?.join('; ')).slice(0, 80)})` } });
        continue;
      }
      if (attempt < LIMITS.attemptsPerTask && e.retryable) {
        repair = null;
        store.append({ type: 'progress', taskId, payload: { text: `The model service declined the request (${e.code}); retrying once` } });
        continue;
      }
      const reason = e.code === 'BUDGET_EXCEEDED' ? e.message
        : e.outcomeUnknown ? `${e.message}. The outcome is unknown, so it was not re-sent automatically; its cost is counted at the reserved maximum.`
        : e.message;
      // What the user is offered depends on what kind of failure this is. The one that mattered in W5: the step
      // is asking for something the region cannot carry. Then the question is whether the *chosen direction*
      // itself is deliverable — if it is not, running the same step again cannot honour the choice, however many
      // times it is paid for, so no Retry is offered; the user is told, and only the directions that pass the
      // same check are offered as alternatives.
      const outOfScope = e.code === 'OUTPUT_INVALID' && (e.problems ?? []).some((x) => /outside this region|cannot add|only exists in the preview|cannot deliver/.test(String(x)));
      const { chosen, alternatives } = directionsNow(ctx);
      const chosenImpossible = outOfScope && chosen && checkProposal({ proposal: chosen, region: ctx.region?.() }).length > 0;
      const canChooseAgain = outOfScope && alternatives.length > 0;
      const said = !outOfScope ? reason
        : [
          outOfScopeNote(e.problems),
          'Nothing was written and the page is unchanged.',
          chosenImpossible ? `Direction ${chosen.id} cannot be built here at all, so trying this step again would hit the same wall.` : '',
          canChooseAgain ? `You can switch to ${alternatives.map((x) => x.id).join(' or ')}, which this area can deliver — the team does not start over and no new work is paid for.`
            : chosenImpossible ? 'None of the directions offered in this round can be built in this area, so there is nothing to switch to. Your goal, the reference and the reading of it stay in the record.' : '',
        ].filter(Boolean).join(' ');
      return {
        ...failTask(ctx, state, taskId, {
          code: e.code || 'ERROR', reason: said,
          userRetry: e.code !== 'BUDGET_EXCEEDED' && !chosenImpossible,
          canChooseAgain,
        }),
        taskId,
      };
    }
  }
  throw new Error('unreachable');
}

const repairNote = (problems) => (problems ? [{ type: 'text', text: `Your previous output did not pass the program's checks: ${problems.join('; ')}. Output it again in full and fix these problems${problems.some((x) => /truncated|max_tokens/i.test(x)) ? '; last time it was cut off for length, so keep every field shorter' : ''}.` }] : []);

// A program step shown as a task card (no model). `fn` returns { summary } or { failed, code, reason, userRetry }.
async function programTask(ctx, state, { node, role, title, inputs, handoffTo, fn }) {
  const { store } = ctx;
  const taskId = newTaskId(node, state);
  store.append({ type: 'task_created', taskId, role, regionId: ctx.regionId(), version: ctx.versionLabel(), payload: { node, title, inputs, kind: 'program', action: title } });
  const instanceId = `p-${node}-${Date.now().toString(36)}`;
  store.append({ type: 'instance_started', taskId, instanceId, role, payload: { action: title, model: 'program', attempt: 1 } });
  let out;
  try {
    out = await fn(taskId);
  } catch (e) {
    if (e.name === 'AbortError' || ctx.signal()?.aborted) throw abortedError();
    out = { failed: true, code: e.code || 'PROGRAM_ERROR', reason: `A program step failed: ${String(e.message).slice(0, 200)}`, userRetry: true };
  }
  if (out?.failed) {
    store.append({ type: 'instance_ended', taskId, instanceId, payload: { status: 'failed', code: out.code } });
    return { ...failTask(ctx, state, taskId, out), taskId };
  }
  store.append({ type: 'instance_ended', taskId, instanceId, payload: { status: 'ok' } });
  const acc = store.append({ type: 'instance_finished', taskId, epoch: state.epoch, payload: { handoffTo, summary: out?.summary } });
  if (!acc.accepted) throw abortedError();
  return { taskId, ...out };
}

// `forSeq` = seq of the fact being decided on. The node re-runs from the top when resumed, so the wait fact is
// recorded only if no wait of this kind exists yet after that fact (open or already answered).
function waitNode(ctx, state, { kind, prompt, options, refs, forSeq, producerTaskId }) {
  const p = ctx.store.project();
  if (!p.waitLog.some((w) => w.kind === kind && w.epoch === p.epoch && w.seq > forSeq)) {
    // The wait belongs to the task whose result is being decided on. Falling back to "the last task that ran" is
    // wrong when the question is asked again later (pick a different direction): that would hang the choice on
    // the step that failed, which has already been marked replaced.
    const producer = producerTaskId ?? [...p.order].reverse().find((id) => p.tasks[id].epoch === p.epoch && p.tasks[id].kind !== 'program') ?? p.order.at(-1);
    ctx.store.append({ type: 'waiting_user', taskId: producer, epoch: state.epoch, payload: { kind, prompt, options, refs } });
  }
  // Re-runs on resume. The decision itself was appended by the command handler (validated there); nothing else here.
  interrupt({ kind, epoch: state.epoch });
  return { route: null };
}

const readText = (ctx, rel) => fs.readFileSync(path.join(ctx.projectRoot, rel), 'utf8');
const png = (ctx, name) => imageBlock(fs.readFileSync(ctx.store.binaryPath(name)), 'image/png');
function referenceBlock(ctx, p) {
  const ref = ctx.store.readArtifact(p.brief.referenceId);
  return imageBlock(fs.readFileSync(ctx.store.binaryPath(ref.data.file)), ref.data.mediaType, ref.data.w, ref.data.h);
}
const diskMatchesRunning = (ctx) => { const p = ctx.store.project(); return !p.running || ctx.version().hash === p.running.hash; };
const outsideChange = (ctx, rel) => ({ failed: true, code: 'STALE_BASELINE', reason: `${rel} was changed outside the studio after the last recorded version (${ctx.store.project().running?.label}). Nothing was written; the outside change was kept.`, userRetry: false });

// ---------- graph ----------
export function buildGraph(ctx, { checkpointer = new MemorySaver() } = {}) {
  const S = () => ctx.store.project();
  const R = ctx.region();
  const CSS = R.allowedFiles[0];
  // M1 (D-028): one instance carries the responsibilities that six calls carried before, and the region's
  // component is writable as well as its styles. Everything protective stays where it was.
  const FILES = R.allowedFiles;
  const FAST = R.mode === 'single-call';
  // What this region can actually be changed with — the same words for every role, derived from the registry.
  const CAN = capabilityText(R);
  const read = (a) => (a ? ctx.store.readArtifact(a.id) : null);
  const R_ = (kind, since) => read(inRound(S(), kind, since));
  const confirmedInterp = () => { const p = S(); const it = [...p.interpretations].reverse().find((x) => x.confirmed); return it ? ctx.store.readArtifact(it.id) : null; };
  const roundStartVersion = () => { const before = R_('evidence-before'); const p = S(); return [...p.versions].reverse().find((v) => v.hash === before.data.version.hash && v.snapshot); };

  const g = new StateGraph(GraphState)
    .addNode('router', async () => {
      const p = S();
      return { round: p.round, epoch: p.epoch, route: nextNode(p), refs: Object.fromEntries(Object.entries(p.latest).filter(([, id]) => p.artifacts[id]?.epoch === p.epoch)) };
    })

    // Execution layer (program): this round's starting version and before-evidence
    .addNode('intake', async (state) => {
      await programTask(ctx, state, {
        node: 'intake', role: 'exec', title: state.round === 1 ? 'Record the starting version and before screenshots' : `Record round ${state.round}'s starting version and screenshots`, handoffTo: 'pm', inputs: ['region', 'disk'],
        fn: async (taskId) => {
          const p = S();
          if (state.round > 1 && !diskMatchesRunning(ctx)) return outsideChange(ctx, CSS);
          if (!(await ctx.targetReachable())) return { failed: true, code: 'TARGET_DISCONNECTED', reason: `The page at ${ctx.targetUrl} is not responding, so no screenshots could be taken. Nothing was written. Start the page again, then retry.`, userRetry: true };
          const v = p.running && state.round > 1 ? p.running : observeVersion(ctx, { kind: 'original', extra: { all: ctx.allSourceHashes() } });
          ctx.store.append({ type: 'progress', taskId, payload: { text: 'Opening the running page; capturing the region, neighbour and expanded state at 1440 / 900 px' } });
          const ev = await ctx.captureEvidence(`before-r${state.round}`);
          const data = persistEvidence(ctx.store, ev, `before-r${state.round}-${Date.now().toString(36)}`);
          const id = ctx.store.saveArtifact('evidence-before', { ...data, version: { files: v.files, hash: v.hash, short: v.hash.slice(0, 8), label: v.label }, all: ctx.allSourceHashes() });
          const acc = ctx.store.append({ type: 'artifact_created', taskId, epoch: state.epoch, payload: { id, kind: 'evidence-before', title: `Before evidence (${v.label})` } });
          if (!acc.accepted) throw abortedError();
          return { summary: `${v.label} = ${v.hash.slice(0, 8)}; screenshots at ${Object.keys(data.shots).join('/')} px` };
        },
      });
      return {};
    })

    // Project manager (R01)
    .addNode('pm_brief', async (state) => {
      const p = S();
      const before = R_('evidence-before').data;
      const r = state.round;
      const prevHand = r > 1 ? ctx.store.readArtifact(inheritedHandoff(p).id) : null;
      const lastReview = r > 1 ? read(Object.values(p.artifacts).filter((a) => a.kind === 'review' && a.round < r).sort((a, b) => a.seq - b.seq).at(-1)) : null;
      const feedback = p.roundStarts[r]?.feedback;
      await roleTask(ctx, state, {
        node: 'pm_brief', role: 'pm', method: roles.pmBrief, title: r === 1 ? 'Plan this round and its completion conditions' : `Plan round ${r} from your feedback`, kind: 'pm-plan', handoffTo: r === 1 ? 'ref' : 'visual',
        inputs: r === 1 ? [`brief#${p.brief.seq}`, p.latest['evidence-before'], R.sourceFile, CSS] : [`round#${r}`, prevHand.id, lastReview?.id, p.latest['evidence-before'], CSS].filter(Boolean),
        summarize: (o) => `${o.mode === 'initial' ? '' : `${o.mode === 'adjust' ? 'Adjust within the chosen direction' : 'New direction'} · `}${o.restatement}`,
        eventExtra: (o) => ({ mode: o.mode }),
        build: async (repair) => ({
          maxTokens: 5000,
          validate: roles.pmBrief.validator({ round: r, previousCriteriaIds: prevHand ? prevHand.data.criteria.map((c) => c.id) : [] }),
          content: [
            { type: 'text', text: r === 1
              ? `ROUND 1.\nUser's request: ${p.brief.goal}\nReference: ${p.brief.noReference ? 'the user said there is no reference' : `one reference image (${p.brief.referenceName || 'image'}); the reference researcher will interpret it`}\nRegion: ${R.regionId} (component ${R.component}, ${R.label})\nFiles that may be changed automatically: ${R.allowedFiles.join(', ')}\nRegistered preserved items: ${R.preserve.join('; ')}\n${CAN}\nCurrent source ${R.sourceFile}:\n${readText(ctx, R.sourceFile)}\nCurrent CSS ${CSS}:\n${readText(ctx, CSS)}\nImage: the region now (1440 px).`
              : `ROUND ${r}. The user's feedback on the current running version ${p.running?.label}: ${feedback}\nAdopted version: ${p.adopted ? p.adopted.label : 'none yet'}\nPrevious round's handoff — chosen direction: ${JSON.stringify(prevHand.data.direction)}; user's earlier words: ${prevHand.data.modification || '(none)'}; completion criteria: ${prevHand.data.criteria.map((c) => `${c.id}: ${c.text}`).join(' | ')}; preserved items: ${prevHand.data.keep.join('; ')}\nLast review: ${lastReview ? `${lastReview.data.summary} Deviations: ${lastReview.data.deviations.map((d) => `${d.element} ${d.property}: ${d.what}`).join(' | ') || 'none'}` : 'none'}\nFiles that may be changed automatically: ${R.allowedFiles.join(', ')}\nCurrent CSS ${CSS}:\n${readText(ctx, CSS)}\nImage: the region as it runs now (1440 px).` },
            png(ctx, before.shots['1440'].region),
            ...repairNote(repair),
          ],
        }),
      });
      return {};
    })

    // Reference research (R02) — round 1; later rounds inherit the confirmed interpretation
    .addNode('interpret', async (state) => {
      const p = S();
      const pm = R_('pm-plan').data;
      const before = R_('evidence-before').data;
      const prevId = p.latest.interpretation;
      const corr = prevId ? after(p, 'correct-interpretation', p.artifacts[prevId].seq) : null;
      const prev = corr ? ctx.store.readArtifact(prevId).data : null;
      const hasReference = !p.brief.noReference;
      await roleTask(ctx, state, {
        node: 'interpret', role: 'ref', method: roles.interpret, title: corr ? 'Re-interpret the reference with your correction' : hasReference ? 'Explain how to use the reference and what to keep' : 'No reference: find rules worth keeping on the current page',
        kind: 'interpretation', handoffTo: 'user',
        inputs: [p.latest['pm-plan'], p.latest['evidence-before'], hasReference ? p.brief.referenceId : 'no-reference', ...(corr ? [prevId, `decision#${corr.seq}`] : [])],
        summarize: (o) => `Borrow ${o.borrow.length} · skip ${o.skip.length} · keep ${o.keep.length}${o.cannotDoHere?.length ? ` · ${o.cannotDoHere.length} not possible here` : ''}`,
        build: async (repair) => ({
          maxTokens: 5000,
          validate: roles.interpret.validator({ hasReference, correction: !!corr, goal: p.brief.goal, region: R }),
          content: [
            { type: 'text', text: `User's goal: ${p.brief.goal}\nProject manager's restatement: ${pm.restatement}\nProject manager's keep list: ${pm.keep.join('; ')}\nRegion: ${R.regionId} (component ${R.component}).\nCurrent source ${R.sourceFile}:\n${readText(ctx, R.sourceFile)}\nCurrent CSS ${CSS}:\n${readText(ctx, CSS)}\n${hasReference ? "Image 1: the region now (1440 px). Image 2: the user's reference." : 'Image: the region now (1440 px). The user said there is no reference.'}${corr ? `\n\nPrevious interpretation (corrected by the user, no longer valid): ${JSON.stringify(prev)}\nThe user's correction, verbatim: ${corr.text}` : ''}` },
            png(ctx, before.shots['1440'].region),
            ...(hasReference ? [referenceBlock(ctx, p)] : []),
            ...repairNote(repair),
          ],
        }),
      });
      return {};
    })

    .addNode('await_interpretation', (state) => {
      const p = S();
      return waitNode(ctx, state, { kind: 'confirm-interpretation', prompt: 'Is this reading of your reference and of what to keep right?', options: ['confirm', 'correct', 'cancel'], refs: { interpretationId: p.latest.interpretation }, forSeq: p.artifacts[p.latest.interpretation].seq });
    })

    // Creative lead (R03) — round 1, or a later round whose feedback asks for a new direction
    .addNode('propose', async (state) => {
      const p = S();
      const r = state.round;
      const pm = R_('pm-plan').data;
      const interp = confirmedInterp();
      const before = R_('evidence-before').data;
      const start = p.roundStarts[r]?.seq ?? 0;
      const rejects = p.decisions.filter((d) => d.kind === 'reject' && d.round === r && d.epoch === p.epoch && d.seq > start);
      const prevHand = r > 1 ? ctx.store.readArtifact(inheritedHandoff(p).id).data : null;
      const base = ctx.version();
      await roleTask(ctx, state, {
        node: 'propose', role: 'lead', method: roles.propose, title: rejects.length ? `Propose again, using your reasons (attempt ${rejects.length + 1})` : r === 1 ? 'Propose design directions' : `Propose new directions for round ${r}`, kind: 'proposals', handoffTo: 'user',
        inputs: [interp.id, p.latest['pm-plan'], p.latest['evidence-before'], ...rejects.map((d) => `decision#${d.seq}`)],
        summarize: (o) => `${o.proposals.map((x) => `${x.id} ${x.name}`).join(' / ')}; recommends ${o.recommended}`,
        artifactMeta: (o) => ({ baseVersion: base, digests: Object.fromEntries(o.proposals.map((x) => [x.id, digestOf(x)])) }),
        build: async (repair) => ({
          maxTokens: 7000,
          validate: roles.propose.validator({ region: R }),
          content: [
            { type: 'text', text: `${r === 1 ? `User's goal: ${p.brief.goal}` : `Round ${r}. The user's feedback on the current running version: ${p.roundStarts[r].feedback}\nCurrent direction (being replaced): ${JSON.stringify(prevHand.direction)}`}\nProject manager's completion conditions: ${pm.goalCriteria.map((c) => c.text).join('; ')}\nConfirmed interpretation: ${JSON.stringify({ mode: interp.data.mode, borrow: interp.data.borrow, skip: interp.data.skip })}\nPreserved items: ${[...new Set([...interp.data.keep, ...pm.keep])].join('; ')}\nRegion root class: ${R.classes[0]}; inner classes: ${R.classes.slice(1).join(', ')}\n${CAN}\nCurrent CSS:\n${readText(ctx, CSS)}${rejects.length ? `\nThe user turned down the previous directions because: ${rejects.map((d) => d.reason).join('; ')}` : ''}\nImage: the region now (1440 px).` },
            png(ctx, before.shots['1440'].region),
            ...repairNote(repair),
          ],
        }),
      });
      return {};
    })

    .addNode('await_choice', (state) => {
      const p = S();
      const props = ctx.store.readArtifact(inRound(p, 'proposals').id);
      // After "pick a different direction" the earlier choice no longer counts, so the question is asked again —
      // the same cut-off the router uses, otherwise the wait would be swallowed as already answered.
      // `blocked` is normally empty: today's directions are checked before they are offered. It fills in when a
      // round from before that check is re-opened, and then the user is told which ones cannot be built here
      // instead of being allowed to pick one and wait for it again.
      const blocked = blockedProposals({ proposals: props.data.proposals, region: R });
      return waitNode(ctx, state, { kind: 'choose', prompt: 'Choose a direction (you can add changes), or turn them all down and say why', options: [...props.data.proposals.filter((x) => !blocked[x.id]).map((x) => x.id), 'reject', 'cancel'], refs: { proposalsId: props.id, digests: props.digests, baseHash: props.baseVersion.hash, blocked }, forSeq: Math.max(p.artifacts[props.id].seq, chooseAgainSeq(p)), producerTaskId: p.artifacts[props.id].taskId });
    })

    // Visual & interaction designer (R04)
    .addNode('refine', async (state) => {
      const p = S();
      const r = state.round;
      const pm = R_('pm-plan').data;
      const interp = confirmedInterp().data;
      const before = R_('evidence-before').data;
      const propsA = inRound(p, 'proposals');
      let chosen; let modification; let inputs;
      if (propsA) {
        const props = ctx.store.readArtifact(propsA.id);
        const choice = after(p, 'choose', propsA.seq);
        chosen = props.data.proposals.find((x) => x.id === choice.value);
        modification = choice.modification;
        inputs = [propsA.id, `decision#${choice.seq}`, p.latest['pm-plan']];
      } else {
        const prevA = inheritedHandoff(p);
        const prev = ctx.store.readArtifact(prevA.id).data;
        chosen = { id: prev.direction.id, name: prev.direction.name, intent: prev.direction.intent, changes: prev.direction.changes, referenceUse: prev.direction.referenceUse, keepPromise: prev.direction.keepPromise };
        modification = `${p.roundStarts[r].feedback}${pm.changes.length ? ` — changes: ${pm.changes.join('; ')}` : ''}`;
        inputs = [prevA.id, p.latest['pm-plan'], `round#${r}`];
      }
      await roleTask(ctx, state, {
        node: 'refine', role: 'visual', method: roles.refine, title: propsA ? `Turn direction ${chosen.id} into a spec and completion conditions` : `Spec round ${r}'s changes`, kind: 'spec', handoffTo: 'pm',
        inputs,
        summarize: (o) => `${o.rules.length} CSS rules · ${o.criteria.length} completion conditions`,
        build: async (repair) => ({
          maxTokens: 8000,
          validate: roles.refine.validator({ classes: R.classes, modifiers: R.selectorModifiers, modification, region: R }),
          content: [
            { type: 'text', text: `${r === 1 ? `ROUND 1. User's goal: ${p.brief.goal}` : `ROUND ${r}, starting from the running version ${p.running?.label}. Specify ONLY this round's changes; everything else stays as it is now.\nThe user's feedback, verbatim: ${p.roundStarts[r].feedback}\nProject manager's list of changes: ${pm.changes.join('; ')}`}\nChosen direction ${chosen.id}: ${JSON.stringify(chosen)}\nThe user's words for this direction: ${modification || '(none)'}\nReference — borrow: ${JSON.stringify(interp.borrow)}; skip: ${JSON.stringify(interp.skip)}\nPreserved items: ${[...new Set([...interp.keep, ...pm.keep])].join('; ')}\nProject manager's completion conditions: ${pm.goalCriteria.map((c) => c.text).join('; ')}\nClasses in the region: ${R.classes.join(', ')} (root .${R.classes[0]})\n${CAN}${R.selectorModifiers?.length ? `
Page-level modifier classes you may prefix with (not target on their own): ${R.selectorModifiers.join(', ')}` : ''}\nCurrent CSS ${CSS}:\n${readText(ctx, CSS)}\nCurrent source (read-only):\n${readText(ctx, R.sourceFile)}\nImage: the region now (1440 px).` },
            png(ctx, before.shots['1440'].region),
            ...repairNote(repair),
          ],
        }),
      });
      return {};
    })

    // Project manager (program part): assemble the handoff only from effective decisions (P02-M01)
    .addNode('handoff', async (state) => {
      await programTask(ctx, state, {
        node: 'handoff', role: 'pm', title: 'Assemble the handoff (effective decisions only)', handoffTo: 'impl', inputs: ['decisions', 'proposals', 'interpretation', 'spec', 'pm-plan', 'disk'],
        fn: async (taskId) => {
          const p = S();
          const r = state.round;
          const now = ctx.version();
          if (!diskMatchesRunning(ctx)) return outsideChange(ctx, CSS);
          const pmA = R_('pm-plan');
          const spec = R_('spec');
          const interpA = confirmedInterp();
          const propsA = inRound(p, 'proposals');
          const prevA = r > 1 ? inheritedHandoff(p) : null;
          const prev = prevA ? ctx.store.readArtifact(prevA.id).data : null;
          let direction; let modification; let choiceRef; let notUsed = []; let chosenBy;
          if (propsA) {
            const props = ctx.store.readArtifact(propsA.id);
            const choice = after(p, 'choose', propsA.seq);
            const chosen = props.data.proposals.find((x) => x.id === choice.value);
            if (!chosen || digestOf(chosen) !== choice.digest || props.digests[chosen.id] !== choice.digest) {
              return { failed: true, code: 'STALE_PROPOSAL', reason: 'The chosen proposal is not the one you saw when choosing; the choice cannot authorize a write.', userRetry: false };
            }
            if (now.hash !== props.baseVersion.hash) {
              return { failed: true, code: 'STALE_PROPOSAL', reason: `The page changed after the proposals were made (${props.baseVersion.short} → ${now.short}); the old choice cannot authorize a write.`, userRetry: false };
            }
            direction = { id: chosen.id, name: chosen.name, intent: chosen.intent, changes: chosen.changes, referenceUse: chosen.referenceUse, keepPromise: chosen.keepPromise, digest: choice.digest, round: r };
            modification = choice.modification || '';
            choiceRef = `decision#${choice.seq}`;
            chosenBy = choice.by;
            notUsed = props.data.proposals.filter((x) => x.id !== chosen.id).map((x) => `${x.id} (not chosen — no effect on implementation)`);
          } else {
            direction = { ...prev.direction };
            modification = p.roundStarts[r].feedback;
            choiceRef = `inherited from ${prevA.id}`;
            chosenBy = prev.chosenBy;
          }
          const supersedes = r > 1 ? pmA.data.supersedes : [];
          const carried = prev ? prev.criteria.filter((c) => !c.id.startsWith('K') && !supersedes.includes(c.id)) : [];
          const keepItems = [...new Set([...(prev ? prev.keep : interpA.data.keep), ...(r > 1 ? pmA.data.keep : [])])];
          const criteria = [
            ...pmA.data.goalCriteria.map((c, i) => ({ id: `G${i + 1}`, source: r === 1 ? 'Project manager (from your words)' : `Project manager (from your round ${r} feedback)`, text: c.text, howToCheck: c.howToCheck })),
            ...spec.data.criteria.map((c, i) => ({ id: `S${i + 1}`, source: 'Visual & interaction spec', text: c.text, width: c.width, howToCheck: c.howToCheck })),
            ...carried.map((c, i) => ({ id: `C${i + 1}`, source: `Carried over from round ${r - 1} (${c.id})`, text: c.text, width: c.width, howToCheck: c.howToCheck, was: c.id })),
            ...keepItems.map((k, i) => ({ id: `K${i + 1}`, source: 'Preserved item', text: k })),
          ];
          const handoff = {
            round: r,
            goal: r === 1 ? p.brief.goal : p.roundStarts[r].feedback,
            mode: pmA.data.mode,
            region: { id: R.regionId, component: R.component, sourceFile: R.sourceFile, allowedFiles: R.allowedFiles },
            direction, modification, chosenBy,
            changes: pmA.data.changes,
            reference: { mode: interpA.data.mode, borrow: interpA.data.borrow, skip: interpA.data.skip, interpretationId: interpA.id, version: p.interpretations.findIndex((x) => x.id === interpA.id) + 1 },
            keep: keepItems,
            spec: { summary: spec.data.summary, modificationApplied: spec.data.modificationApplied, rules: spec.data.rules, states: spec.data.states },
            criteria,
            supersedes: supersedes.map((id) => ({ id, text: prev.criteria.find((c) => c.id === id)?.text })),
            baseVersion: { ...now, label: p.running?.label },
            adopted: p.adopted ? { label: p.adopted.label, hash: p.adopted.hash } : null,
            artifacts: { pmPlan: pmA.id, interpretation: interpA.id, proposals: propsA?.id ?? null, choice: choiceRef, spec: spec.id, previousHandoff: prevA?.id ?? null },
            openIssues: [...pmA.data.outOfScope.map((x) => `Out of scope: ${x}`), ...(interpA.data.openQuestion ? [`Open question: ${interpA.data.openQuestion}`] : [])],
            notUsed,
            frozenAt: new Date().toISOString(),
          };
          const id = ctx.store.saveArtifact('handoff', handoff, { digest: digestOf(handoff), round: r });
          const acc = ctx.store.append({ type: 'artifact_created', taskId, epoch: state.epoch, payload: { id, kind: 'handoff', title: `Handoff · round ${r} · direction ${direction.id} · ${criteria.length} criteria (frozen)` } });
          if (!acc.accepted) throw abortedError();
          return { summary: `Direction ${direction.id}${modification ? ' + your words' : ''} · based on ${p.running?.label} ${now.short} · ${criteria.length} criteria${supersedes.length ? ` · replaces ${supersedes.join(', ')}` : ''}` };
        },
      });
      return {};
    })

    // Implementer (R05) — the handoff, or (fix cycle) the reviewer's located deviations
    // M1 (D-028): one instance, the whole job. The responsibilities are still shown separately in the
    // workbench — attributed to this instance, with what it actually did, not split into invented workers.
    .addNode('build', async (state) => {
      const p = S();
      if (state.round > 1 && !diskMatchesRunning(ctx)) {
        await programTask(ctx, state, { node: 'implement', role: 'impl', title: 'Check the files before changing them', handoffTo: 'user', inputs: ['disk'], fn: async () => outsideChange(ctx, FILES.join(' / ')) });
        return {};
      }
      const before = R_('evidence-before').data;
      const current = Object.fromEntries(FILES.map((f) => [f, readText(ctx, f)]));
      const base = ctx.version();
      // The reference the user attached travels with the task: it is the same reference in every later round,
      // and if they said there is none, none is sent. A reference that cannot be read is said out loud before
      // the call rather than quietly dropped — the user is told what the team worked without.
      const hasRef = !!p.brief.referenceId && !p.brief.noReference;
      let refImage = null; let refProblem = '';
      if (hasRef) {
        try { refImage = referenceBlock(ctx, p); } catch (e) { refProblem = `The reference "${p.brief.referenceName ?? 'image'}" could not be opened (${String(e.message).slice(0, 80)}), so this round was designed from the page itself.`; }
      }
      if (refProblem) ctx.store.append({ type: 'note', payload: { tone: 'warn', code: 'REFERENCE_UNREADABLE', text: refProblem } });
      const feedback = p.decisions.filter((d) => d.kind === 'round-decision' && d.value === 'feedback' && d.round < state.round).at(-1);
      const earlier = Object.values(p.artifacts).filter((a) => a.kind === 'build' && a.round < state.round).sort((a, b) => a.seq - b.seq).at(-1);
      const earlierData = earlier ? read(earlier).data : null;
      const r = await roleTask(ctx, state, {
        node: 'implement', role: 'impl', method: roles.build, kind: 'build', handoffTo: 'exec',
        title: state.round === 1 ? 'Understand the goal, decide the design and write the change' : 'Apply your feedback to the current version',
        inputs: ['goal', ...(refImage ? [p.brief.referenceId] : []), ...FILES, R_('evidence-before').id, ...(earlier ? [earlier.id] : [])],
        summarize: (o) => `${o.changes.length} change${o.changes.length === 1 ? '' : 's'}${o.icons.length ? ` · ${o.icons.length} icon${o.icons.length === 1 ? '' : 's'}` : ''} · ${o.edits.length} edit${o.edits.length === 1 ? '' : 's'}`,
        artifactMeta: () => ({ baseVersion: { ...base, label: p.running?.label }, cycle: 'first' }),
        build: async (repair) => ({
          maxTokens: 8000,
          validate: roles.build.validator({ allowedFiles: FILES, current, mustKeep: R.mustKeep ?? {}, forbid: R.forbid ?? [] }),
          content: [
            {
              type: 'text',
              text: [
                state.round === 1
                  ? `What the site owner asked for, in their own words: "${p.brief.goal}"`
                  : `This is round ${state.round}. The owner looked at the running result of the last round and asked, in their own words: "${feedback?.text ?? ''}"\n\nWhat you decided last round: ${earlierData?.approach ?? '(not recorded)'}\nWhat you changed last round: ${JSON.stringify(earlierData?.changes ?? [])}\nChange only what this feedback asks for. Everything else you did last round stays exactly as it is — the files below already contain it.`,
                `Region: ${R.label ?? R.regionId} — the ${R.component} component of a running React site. Its root element is ${(R.classes ?? [])[0] ? `.${R.classes[0]}` : `[data-region-id="${R.regionId}"]`}.`,
                `This stylesheet also styles the rest of the page. Every CSS rule you add or change must style something INSIDE the region: either one of its own classes (${(R.classes ?? []).map((c) => `.${c}`).join(', ')}) or a selector that sits under the root (for a new class, write \`${(R.classes ?? [])[0] ? `.${R.classes[0]}` : '.region'} .your-new-class\`). Do not restyle shared utilities such as .sr-only or .mini on their own — scope them under the root instead. A rule that reaches outside is refused before anything is written.`,
                refImage
                  ? `Image 1 is this region as it looks right now, at 1440 px. Image 2 is the reference the owner attached${p.brief.referenceName ? ` ("${p.brief.referenceName}")` : ''}: borrow from it only what suits this site and say nothing about copying its content.`
                  : `Image 1 is this region as it looks right now, at 1440 px.${refProblem ? ` ${refProblem}` : ' The owner attached no reference, so continue the rules the site already follows.'}`,
                `Must stay true no matter what:\n- ${(R.preserve ?? []).join('\n- ')}`,
                `Files you may change (nothing else exists for you):\n${FILES.map((f) => `--- ${f} ---\n${current[f]}`).join('\n\n')}`,
              ].join('\n\n'),
            },
            png(ctx, before.shots['1440'].region),
            ...(refImage ? [refImage] : []),
            ...repairNote(repair),
          ],
        }),
      });
      if (!r.output) return {};
      // The same five cards the user is used to, filled in from what this instance actually produced, each
      // saying where it came from. The reviewer card is created after the evidence, by the evidence step.
      const o = r.output;
      const covered = [
        ['pm_brief', 'pm', 'Set what this round must deliver — in the same call', o.understanding],
        ['interpret', 'ref', 'Took the rules worth keeping from the site itself — in the same call', (o.keep ?? []).join(' · ') || 'Kept everything listed as preserved'],
        ['propose', 'lead', 'Decided the design direction — in the same call', o.approach],
        ['refine', 'visual', 'Turned it into concrete changes — in the same call', (o.changes ?? []).map((c) => c.what).join(' · ')],
      ];
      for (const [node, role, title, summary] of covered) {
        await programTask(ctx, state, { node, role, title, handoffTo: 'impl', inputs: [r.id], fn: async () => ({ summary: `${summary}`.slice(0, 300) }) });
      }
      return {};
    })

    .addNode('implement', async (state) => {
      const p = S();
      const hand = R_('handoff');
      const fix = fixDecision(p, inRound(p, 'handoff').seq);
      const lastReview = fix ? read(Object.values(p.artifacts).filter((a) => a.kind === 'review' && a.round === state.round && a.seq < fix.seq).sort((a, b) => a.seq - b.seq).at(-1)) : null;
      if (!diskMatchesRunning(ctx)) {
        await programTask(ctx, state, { node: 'implement', role: 'impl', title: 'Check the file before implementing', handoffTo: 'user', inputs: ['disk'], fn: async () => outsideChange(ctx, CSS) });
        return {};
      }
      const cssNow = readText(ctx, CSS);
      const base = ctx.version();
      const r = await roleTask(ctx, state, {
        node: 'implement', role: 'impl', method: roles.implement, title: fix ? 'Fix the review issues' : `Change ${path.basename(CSS)} according to the handoff`, kind: 'patch', handoffTo: 'exec',
        inputs: [hand.id, CSS, ...(lastReview ? [lastReview.id, `decision#${fix.seq}`] : [])],
        summarize: (o) => (o.blocked ? `Cannot do it: ${o.blocked}` : `${o.edits.length} edit${o.edits.length === 1 ? '' : 's'}`),
        artifactMeta: () => ({ baseVersion: { ...base, label: p.running?.label }, cycle: fix ? 'fix' : 'first' }),
        eventExtra: () => ({ cycle: fix ? 'fix' : 'first' }),
        build: async (repair) => ({
          maxTokens: 6000,
          validate: roles.implement.validator(R.allowedFiles, cssNow, R),
          content: [
            { type: 'text', text: `${fix ? `FIX MODE (one fix allowed). Fix exactly these review findings, nothing else:\nDeviations: ${JSON.stringify(lastReview.data.deviations)}\nCriteria judged fail/unclear: ${JSON.stringify(lastReview.data.criteria.filter((c) => c.verdict !== 'pass'))}\n\n` : ''}Handoff: ${JSON.stringify(hand.data)}\n\n${CAN}\n\nThe only file you may change, ${CSS}, current content:\n${cssNow}${R.allowedSelectors?.length ? '\n\nThis stylesheet also styles other parts of the page: a patch that touches any rule outside the classes listed above is refused before anything is written.' : ''}` },
            ...repairNote(repair),
          ],
        }),
      });
      if (r.output?.blocked) failTask(ctx, state, r.taskId, { code: 'IMPL_BLOCKED', reason: `The implementer cannot do this by changing only the allowed file: ${r.output.blocked}`, userRetry: false });
      return {};
    })

    // Execution layer (program): Phase01 executor write, bound to the version the patch was made on
    .addNode('apply', async (state) => {
      await programTask(ctx, state, {
        node: 'apply', role: 'exec', title: 'Write the change (baseline and allowlist checks)', handoffTo: 'exec', inputs: ['patch', 'handoff', 'disk'],
        fn: async (taskId) => {
          const p = S();
          let buildResult = null;
          const patchA = FAST ? inRound(p, 'build') && read(inRound(p, 'build')) : (() => { const handA = inRound(p, 'handoff'); return R_('patch', fixDecision(p, handA.seq)?.seq ?? handA.seq); })();
          ctx.counters?.inc('apply');
          if (!(await ctx.targetReachable())) return { failed: true, code: 'TARGET_DISCONNECTED', reason: `The page at ${ctx.targetUrl} is not responding. Nothing was written. Start the page again, then retry.`, userRetry: true };
          // A shared stylesheet may style other regions too: before anything is written, check that this patch
          // only moves rules that belong to this region (registry: allowedSelectors / selectorModifiers).
          // M1 may edit the region's component as well, so the boundary there is the file allowlist, the
          // must-keep anchors (checked before this step) and the type check below — not CSS selectors.
          // Editing the region's component does not make the shared stylesheet fair game: every rule this patch
          // adds, changes or removes must still style something inside the region. New classes are fine as long
          // as they live under the region (`.site-header .mini-icon`); `footer`, `:not(.site-header)` and
          // `.site-header ~ *` are not, however the region is named inside them.
          const CSSFILE = FILES.find((f) => f.endsWith('.css')) ?? CSS;
          const scope = FAST
            ? checkPatchScope({
              before: readText(ctx, CSSFILE), edits: patchA.data.edits, file: CSSFILE, ignoreOtherFiles: true,
              inScope: (sel) => selectorTargetsRegion(sel, { classes: (R.classes ?? []).map((c) => `.${c}`), modifiers: R.selectorModifiers ?? [] }),
            })
            : checkPatchScope({ before: readText(ctx, CSS), edits: patchA.data.edits, allowed: R.allowedSelectors, modifiers: R.selectorModifiers, file: CSS });
          if (!scope.ok) {
            // Retryable on purpose: the patch itself is still the one you chose, and the file has not moved. If the
            // refusal was wrong (or the boundary changed), retrying re-checks the same patch without calling any model.
            const otherDirections = !!inRound(S(), 'proposals');
            return FAST
              ? { failed: true, code: 'SELECTOR_NOT_ALLOWED', reason: `Nothing was written and the page is unchanged: ${scope.reason}. This task can restyle the header and what is inside it; a rule that styles anything else on the page is refused. Try again — the same step runs once more without any new work being paid for.`, userRetry: true }
              : { failed: true, code: 'SELECTOR_NOT_ALLOWED', reason: `Nothing was written: ${scope.reason}. This area can only be changed through ${(R.allowedSelectors || []).join(', ')}.${otherDirections ? ' You can pick a different direction from the ones you already have, without the team starting over.' : ''}`, userRetry: true, canChooseAgain: otherDirections };
          }
          // A snapshot of the region's sources before every write, in a git repository that holds nothing but
          // this copy. The studio's own version chain is still the primary way back; this is a second net.
          const snapId = await ctx.snapshotBaseline?.(`before round ${state.round}: ${String(p.brief?.goal ?? '').slice(0, 80)}`);
          if (snapId) ctx.store.append({ type: 'progress', taskId, payload: { text: `Snapshot of the files before writing: ${snapId}` } });
          let t;
          try {
            t = ctx.exec.createTask({ regionId: R.regionId, expectedBase: patchA.baseVersion.files, patchOverride: { patchId: `w4-${patchA.id}`, regionId: R.regionId, kind: 'runtime-model', title: patchA.cycle === 'fix' ? 'fix' : 'round change', origin: `${patchA.model} ${patchA.promptVersion} ${patchA.instanceId}`, keep: [], edits: patchA.data.edits } });
            ctx.exec.applyTask(t.taskId);
          } catch (e) {
            const why = { STALE_BASELINE: `${CSS} was changed outside the studio after the patch was prepared. The old patch was not written; the outside change was kept.`, PATCH_NO_MATCH: `The patch no longer matches the file. Nothing was written. (${e.message})`, PATH_NOT_ALLOWED: `The patch tried to change a file outside the allowlist. Nothing was written. (${e.message})` }[e.code] || `The execution layer refused the write: ${e.message}`;
            return { failed: true, code: e.code || 'APPLY_ERROR', reason: why, userRetry: false };
          }
          // A component that does not compile takes the running page down with it, so it is checked here and
          // undone at once — the user never sees a broken page and has nothing to retry.
          // The written files are a candidate until this says otherwise. A compile error undoes them; so does a
          // check that could not be completed — an unverified version must not end up in front of the user as
          // something to adopt. Either way the page goes back to the version it had.
          if (FAST) {
            ctx.store.append({ type: 'progress', taskId, payload: { text: 'Written as a candidate; checking that the component still compiles' } });
            const build = ctx.typeCheck ? await ctx.typeCheck() : { status: 'unknown', message: 'no type checker is configured for this project' };
            buildResult = build;
            if (build.status !== 'passed') {
              ctx.exec.restoreTask(t.taskId);
              const back = ctx.version();
              const same = back.hash === patchA.baseVersion.hash;
              const where = `The page is back on ${patchA.baseVersion.label ?? 'the version it had'} (${patchA.baseVersion.short ?? String(patchA.baseVersion.hash).slice(0, 8)})${same ? '' : ' — the files on disk no longer match it, so check the page before carrying on'}.`;
              return build.status === 'failed'
                ? { failed: true, code: 'BUILD_FAILED', reason: `The change did not compile, so it was undone and nothing was kept. ${where} ${build.message.slice(0, 280)}`, userRetry: true }
                : { failed: true, code: 'BUILD_UNVERIFIED', reason: `The change was written but could not be checked, so it was undone rather than shown as finished: ${build.message} ${where}`, userRetry: true };
            }
          }
          const task = ctx.exec.getTask(t.taskId);
          const v = ctx.version();
          const changedFiles = FILES.filter((f) => task.files[f] && task.files[f].afterHash !== task.files[f].baseHash);
          const diffId = ctx.store.saveArtifact('diff', {
            execTaskId: t.taskId, file: changedFiles.join(', ') || CSS, cycle: patchA.cycle,
            diff: (changedFiles.length ? changedFiles : [CSS]).map((f) => `--- ${f}\n${task.files[f].diff}`).join('\n'),
            before: task.files[changedFiles[0] ?? CSS].baseHash, after: task.files[changedFiles[0] ?? CSS].afterHash,
            files: Object.fromEntries((changedFiles.length ? changedFiles : [CSS]).map((f) => [f, { diff: task.files[f].diff, before: task.files[f].baseHash, after: task.files[f].afterHash }])),
          }, { round: state.round });
          const acc = ctx.store.append({ type: 'applied', taskId, epoch: state.epoch, payload: { execTaskId: t.taskId, before: patchA.baseVersion, after: v, diffId, cycle: patchA.cycle } });
          if (!acc.accepted) {
            // Cancelled while writing: undo immediately; the late write must not stay.
            ctx.exec.restoreTask(t.taskId);
            ctx.store.append({ type: 'note', payload: { tone: 'warn', code: 'LATE_WRITE_UNDONE', text: 'The cancel arrived while the change was being written; the write was undone right away.' } });
            throw abortedError();
          }
          ctx.store.append({ type: 'artifact_created', taskId, epoch: state.epoch, payload: { id: diffId, kind: 'diff', title: `Actual diff (${changedFiles.join(', ') || CSS})` } });
          const obs = observeVersion(ctx, { kind: 'result', extra: { execTaskId: t.taskId } });
          if (buildResult) ctx.store.append({ type: 'tech_check', taskId, epoch: state.epoch, payload: { ok: true, items: [{ id: 'T0', text: 'The component compiles (project TypeScript)', ok: true, detail: `${Math.round((buildResult.ms ?? 0) / 100) / 10}s` }] } });
          return { summary: `Wrote ${changedFiles.join(' and ') || CSS}: ${patchA.baseVersion.label} → ${obs.label} (${v.short})` };
        },
      });
      return {};
    })

    // Execution layer (program): after-evidence, round diff and technical checks
    .addNode('evidence', async (state) => {
      await programTask(ctx, state, {
        node: 'evidence', role: 'exec', title: 'After screenshots, interaction and technical checks', handoffTo: 'review', inputs: ['disk', 'evidence-before'],
        fn: async (taskId) => {
          const p = S();
          if (!(await ctx.targetReachable())) return { failed: true, code: 'TARGET_DISCONNECTED', reason: `The page at ${ctx.targetUrl} is not responding, so the result could not be captured. The change is written; retry when the page is back.`, userRetry: true };
          ctx.store.append({ type: 'progress', taskId, payload: { text: 'Opening the running page; capturing the region, neighbour and expanded state at the same widths' } });
          const ev = await ctx.captureEvidence(`after-r${state.round}`);
          if (ctx.signal()?.aborted) throw abortedError();
          const data = persistEvidence(ctx.store, ev, `after-r${state.round}-${Date.now().toString(36)}`);
          const v = ctx.version();
          const before = R_('evidence-before').data;
          const ap = p.applies.at(-1);
          const exTask = ctx.exec.getTask(ap.execTaskId);
          const allNow = ctx.allSourceHashes();
          const outside = Object.keys(before.all || {}).filter((f) => !R.allowedFiles.includes(f) && before.all[f] !== allNow[f]);
          const startV = roundStartVersion();
          const roundDiff = startV ? FILES.map((f) => diffSnapshots(ctx, startV, f)).filter(Boolean).join('\n') : '';
          const items = [
            { id: 'T1', text: `Execution task is applied and ${FILES.length > 1 ? 'every file' : 'the file'} on disk equals the written version`, ok: exTask.status === 'applied' && FILES.every((f) => !exTask.files[f] || exTask.files[f].afterHash === v.files[f]) },
            { id: 'T2', text: 'No source file outside the allowlist changed this round', ok: outside.length === 0, detail: outside.join(', ') },
            ...Object.keys(data.shots).map((w) => ({ id: `T3-${w}`, text: `${w} px: ${R.interaction?.label ?? 'the key interaction of this region'}${data.shots[w].toggle.registered === false ? ' — none registered for this region' : ' still works'}`, ok: data.shots[w].toggle.ok })),
            ...Object.keys(data.shots).map((w) => {
              const now = data.shots[w];
              const was = before.shots[w];
              const sameStyle = JSON.stringify(now.neighbourStyles ?? null) === JSON.stringify(was.neighbourStyles ?? null);
              const samePixels = now.neighbourSha === was.neighbourSha;
              return {
                id: `T4-${w}`,
                text: `${w} px: the neighbouring ${R.neighbourLabel ?? 'area'} is not restyled${sameStyle && !samePixels ? ' (it moved or reflowed, its own styling and text are unchanged)' : ''}`,
                ok: now.neighbourStyles === null ? samePixels : sameStyle,
                detail: samePixels ? 'identical screenshot' : 'screenshot differs; compared computed styles and text',
              };
            }),
          ];
          const id = ctx.store.saveArtifact('evidence-after', { ...data, version: { ...v, label: p.running?.label }, roundDiff, roundStart: startV ? { label: startV.label, hash: startV.hash } : null }, { round: state.round });
          const acc = ctx.store.append({ type: 'artifact_created', taskId, epoch: state.epoch, payload: { id, kind: 'evidence-after', title: `After evidence (${p.running?.label} ${v.short})` } });
          if (!acc.accepted) throw abortedError();
          // An item with ok === null was not checked (nothing registered); it neither passes nor fails.
          const judged = items.filter((x) => x.ok !== null);
          ctx.store.append({ type: 'tech_check', taskId, epoch: state.epoch, payload: { ok: judged.every((x) => x.ok), items } });
          return { summary: `Technical checks ${judged.filter((x) => x.ok).length}/${judged.length} passed${judged.length < items.length ? ` · ${items.length - judged.length} not checked` : ''}` };
        },
      });
      return {};
    })

    // Partner / design reviewer (R06)
    .addNode('review', async (state) => {
      const p = S();
      const hand = R_('handoff');
      const before = R_('evidence-before').data;
      const ap = p.applies.at(-1);
      const afterEv = R_('evidence-after', ap.seq).data;
      const fix = fixDecision(p, inRound(p, 'handoff').seq);
      const earlier = fix ? read(Object.values(p.artifacts).filter((a) => a.kind === 'review' && a.round === state.round && a.seq < fix.seq).sort((a, b) => a.seq - b.seq).at(-1)) : null;
      const ids = hand.data.criteria.map((c) => c.id);
      const styleDiff = (w) => {
        const out = [];
        const b = before.shots[w].styles; const a = afterEv.shots[w].styles;
        for (const el of Object.keys(a)) for (const k of Object.keys(a[el])) if (b[el]?.[k] !== a[el][k]) out.push(`${el} ${k}: ${b[el]?.[k]} → ${a[el][k]}`);
        return out.join('\n') || '(no change)';
      };
      const tc = p.techChecks.at(-1);
      const r = await roleTask(ctx, state, {
        node: 'review', role: 'review', method: roles.review, title: fix ? 'Re-review after the fix' : 'Review the real page', kind: 'review', handoffTo: 'pm',
        inputs: [hand.id, p.latest['evidence-before'], p.latest['evidence-after'], ap.diffId, 'tech_check', ...(earlier ? [earlier.id] : [])],
        summarize: (o) => `${o.criteria.filter((c) => c.verdict === 'pass').length}/${o.criteria.length} criteria pass · ${o.deviations.length} deviation(s) · direction ${o.directionMatch}`,
        eventExtra: () => ({ cycle: fix ? 'fix' : 'first' }),
        build: async (repair) => ({
          maxTokens: 12000,
          validate: roles.review.validator(ids),
          content: [
            { type: 'text', text: `Handoff (criteria are frozen; you may not change them): ${JSON.stringify({ round: hand.data.round, goal: hand.data.goal, mode: hand.data.mode, direction: hand.data.direction, userWords: hand.data.modification, changes: hand.data.changes, reference: hand.data.reference, keep: hand.data.keep, spec: hand.data.spec, criteria: hand.data.criteria, supersedes: hand.data.supersedes })}\n${earlier ? `\nThis is the re-review after ONE fix. The earlier review found: ${JSON.stringify(earlier.data.deviations)}. Judge every criterion again on the current page.\n` : ''}\n"Before" = ${before.version.label} (start of round ${state.round}); "after" = the running page now.\nProgram's technical checks: ${JSON.stringify(tc)}\nInteraction: 1440 px ${JSON.stringify(afterEv.shots['1440'].toggle)}; 900 px ${JSON.stringify(afterEv.shots['900'].toggle)}\nComputed style changes at 1440 px (before → after):\n${styleDiff('1440')}\nComputed style changes at 900 px:\n${styleDiff('900')}\n\nActual diff for this round (${afterEv.roundStart?.label} → running):\n${afterEv.roundDiff}\n\nImages in order: ① before 1440 region ② after 1440 region ③ before 900 region ④ after 900 region ⑤ after 1440 expanded ⑥ after 900 expanded ⑦ before 1440 neighbour (This week, must not change) ⑧ after 1440 neighbour.` },
            png(ctx, before.shots['1440'].region), png(ctx, afterEv.shots['1440'].region),
            png(ctx, before.shots['900'].region), png(ctx, afterEv.shots['900'].region),
            png(ctx, afterEv.shots['1440'].expanded), png(ctx, afterEv.shots['900'].expanded),
            png(ctx, before.shots['1440'].neighbour), png(ctx, afterEv.shots['1440'].neighbour),
            ...repairNote(repair),
          ],
        }),
      });
      if (r.output) {
        const o = r.output;
        const pass = o.criteria.every((c) => c.verdict === 'pass') && o.directionMatch === 'pass';
        if (pass) ctx.store.append({ type: 'review_passed', taskId: r.taskId, epoch: state.epoch, payload: { id: r.id, cycle: fix ? 'fix' : 'first' } });
        else ctx.store.append({ type: 'review_returned', taskId: r.taskId, epoch: state.epoch, payload: { id: r.id, cycle: fix ? 'fix' : 'first', reasons: [...o.criteria.filter((c) => c.verdict !== 'pass').map((c) => `${c.id} ${c.verdict === 'fail' ? 'not met' : 'cannot confirm'}: ${c.evidence}`), ...(o.directionMatch !== 'pass' ? [`Direction match: ${o.directionMatch}`] : [])].slice(0, 8), fixes: o.deviations.map((d) => d.fix) } });
      }
      return {};
    })

    .addNode('await_round_decision', (state) => {
      const p = S();
      const t = restoreTargets(p);
      const review = p.reviews.filter((x) => x.round === state.round).at(-1);
      const stopped = p.cancels.filter((c) => c.round === state.round).at(-1);
      const prompt = stopped && (!review || stopped.seq > review.seq)
        ? `Round ${state.round} was ${stopped.reason === 'cancel' ? 'cancelled' : 'redirected'}. The page shows ${p.running?.label}. What next?`
        // No design reviewer ran this round (M1 answers with one call), so say that instead of implying one did.
        : !review ? `The page shows ${p.running?.label}. The program checked that it compiles, that the change stayed inside this area and that the key interactions still work — nobody reviewed the design, that part is yours. What next?`
          : review.pass ? `The review passed (that is not your adoption). The page shows ${p.running?.label}. What next?` : `The review found issues. The page shows ${p.running?.label}. What next?`;
      return waitNode(ctx, state, { kind: 'round-decision', prompt, options: roundOptions(p), refs: { running: p.running?.label, runningHash: p.running?.hash, adopted: p.adopted?.label ?? null, targets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.label])), reviewId: review?.id ?? null }, forSeq: p.anchor });
    })

    .addNode('adopt', async (state) => {
      await programTask(ctx, state, {
        node: 'adopt', role: 'pm', title: 'Record your adoption', handoffTo: 'user', inputs: ['decision', 'disk'],
        fn: async () => {
          const p = S();
          const d = p.decisions.filter((x) => x.kind === 'round-decision' && x.value === 'adopt').at(-1);
          if (!diskMatchesRunning(ctx)) return { failed: true, code: 'ADOPT_CONFLICT', reason: `Not adopted: ${CSS} was changed outside the studio, so the page is no longer ${p.running.label}. The outside change was kept.`, userRetry: false, options: ['acknowledge'] };
          const acc = ctx.store.append({ type: 'adopted', epoch: state.epoch, payload: { label: p.running.label, hash: p.running.hash, files: p.running.files, regionId: R.regionId, by: d.by, decisionSeq: d.seq } });
          if (!acc.accepted) throw abortedError();
          return { summary: `Adopted ${p.running.label} (${p.running.hash.slice(0, 8)})` };
        },
      });
      return {};
    })

    .addNode('restore_version', async (state) => {
      await programTask(ctx, state, {
        node: 'restore_version', role: 'exec', title: 'Restore a version', handoffTo: 'user', inputs: ['decision', 'versions', 'disk'],
        fn: async () => {
          const p = S();
          const d = p.decisions.filter((x) => x.kind === 'round-decision' && x.value === 'restore').at(-1);
          const target = restoreTargets(p)[d.target];
          if (!target) {
            ctx.store.append({ type: 'restore_failed', epoch: state.epoch, payload: { decisionSeq: d.seq, code: 'NO_TARGET', reason: `There is no ${d.target} version to restore.` } });
            return { failed: true, code: 'NO_TARGET', reason: `There is no ${d.target} version different from the page.`, userRetry: false, options: ['acknowledge'] };
          }
          const res = restoreTo(ctx, { target, decisionSeq: d.seq, targetName: d.target });
          if (!res.ok) {
            ctx.store.append({ type: 'restore_failed', epoch: state.epoch, payload: { decisionSeq: d.seq, code: res.code, reason: res.reason } });
            return { failed: true, code: res.code, reason: res.reason, userRetry: false, options: ['acknowledge'] };
          }
          const acc = ctx.store.append({ type: 'restored', epoch: state.epoch, payload: { decisionSeq: d.seq, target: d.target, label: target.label, to: { hash: res.to.hash, short: res.to.short }, execTaskId: res.execTaskId } });
          if (!acc.accepted) throw abortedError();
          return { summary: `Restored the ${d.target} version (${target.label})` };
        },
      });
      return {};
    })

    .addNode('start_round', async (state) => {
      await programTask(ctx, state, {
        node: 'start_round', role: 'pm', title: `Start round ${state.round + 1} from your feedback`, handoffTo: 'pm', inputs: ['decision', 'versions'],
        fn: async () => {
          const p = S();
          const d = p.decisions.filter((x) => x.kind === 'round-decision' && x.value === 'feedback').at(-1);
          const acc = ctx.store.append({ type: 'round_started', round: state.round + 1, epoch: state.epoch, payload: { round: state.round + 1, fromDecision: d.seq, feedback: d.text, base: p.running ? { label: p.running.label, hash: p.running.hash } : null, redirect: d.redirect } });
          if (!acc.accepted) throw abortedError();
          return { summary: `Round ${state.round + 1} starts from ${p.running?.label}` };
        },
      });
      return {};
    })

    .addNode('close_session', async (state) => {
      const p = S();
      ctx.store.append({ type: 'session_closed', epoch: state.epoch, payload: { outcome: p.adopted ? `adopted ${p.adopted.label}` : 'not adopted', running: p.running?.label, adopted: p.adopted?.label ?? null } });
      return {};
    })

    .addEdge(START, 'router')
    .addConditionalEdges('router', (s) => s.route, [...NODES, END]);
  for (const n of NODES) g.addEdge(n, 'router');
  return g.compile({ checkpointer });
}
