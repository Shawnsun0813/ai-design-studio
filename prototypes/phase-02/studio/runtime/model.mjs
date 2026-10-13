// Model adapter (W3). Builds on the W2 adapter (Anthropic TS SDK 0.133.0, messages.parse + zodOutputFormat) with:
// - budget reservation BEFORE each request: a `reserve` row with the worst-case cost is written first; the row is
//   settled afterwards. Unsettled reservations and calls whose usage is unknown (aborted / connection lost, i.e. no
//   response at all) keep counting at their worst-case value — unknown usage is never counted as zero. A request the
//   API answered with an error status produced no tokens, so it settles at zero;
// - no SDK-internal retries (maxRetries 0): whether to retry is decided by the caller, and a request whose outcome is
//   unknown (timeout / connection error) is never re-sent automatically;
// - the API key is read only from the environment by the SDK; it is never logged or sent to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

// Official list prices, USD per million tokens (platform.claude.com pricing, read 2026-10-11 in W2).
export const PRICES = { 'claude-sonnet-5-5': { in: 2, out: 10 } };
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
// Per work package (W3: D-021, W4: D-022): new API spend ≤ US$5 in that package's own ledger; ≤ US$1.5 per session.
export const CAPS = {
  tranche: Number(process.env.STUDIO_TRANCHE_CAP || 5),
  session: Number(process.env.STUDIO_SESSION_CAP || 1.5),
};

export function openLedger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const record = (row) => fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  // One entry per instance: reservation merged with its settlement (if any).
  function instances(filter = () => true) {
    const m = new Map();
    for (const r of rows()) {
      if (!r.instanceId) continue;
      const cur = m.get(r.instanceId) || {};
      m.set(r.instanceId, { ...cur, ...r, kind: undefined, reserved: cur.reserved ?? (r.kind === 'reserve' ? r.worstUsd : undefined), settled: cur.settled || r.kind === 'settle' });
    }
    return [...m.values()].filter(filter);
  }
  // Amount counted against the caps: known cost, else the worst-case reservation.
  const counted = (i) => (i.settled && !i.usdUnknown ? i.usd || 0 : i.reserved || 0);
  function summary(filter) {
    const xs = instances(filter);
    return {
      calls: xs.length,
      knownUsd: round(xs.filter((i) => i.settled && !i.usdUnknown).reduce((a, i) => a + (i.usd || 0), 0)),
      unknownCalls: xs.filter((i) => !i.settled || i.usdUnknown).length,
      unknownWorstUsd: round(xs.filter((i) => !i.settled || i.usdUnknown).reduce((a, i) => a + (i.reserved || 0), 0)),
      countedUsd: round(xs.reduce((a, i) => a + counted(i), 0)),
    };
  }
  return { file, rows, record, instances, summary };
}
const round = (x) => Math.round(x * 1e6) / 1e6;

export const costOf = (model, usage) => {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return round((input * p.in + (usage.output_tokens || 0) * p.out) / 1e6);
};

export class ModelError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// Conservative input-token estimate used only for the reservation: ~1 token per 1.5 chars of text,
// images by the documented (w*h)/750 rule capped at the 1.15MP downscale, plus overhead.
export function estimateInputTokens(system, content) {
  let t = 400 + Math.ceil((system || '').length / 1.5);
  for (const b of content) {
    if (b.type === 'text') t += Math.ceil(b.text.length / 1.5);
    if (b.type === 'image') t += Math.min(1600, Math.ceil(((b.w || 1600) * (b.h || 1200)) / 750)) + 100;
  }
  return t;
}

export function createModel({ ledger, sessionId, model = DEFAULT_MODEL, client, caps = CAPS }) {
  const api = client ?? new Anthropic({ maxRetries: 0, timeout: 180_000 });
  const worst = (inTok, maxTokens) => round((inTok * PRICES[model].in + maxTokens * PRICES[model].out) / 1e6);

  async function call({ role, promptVersion, system, content, schema, validate, maxTokens = 4000, signal, instanceId = `i-${randomUUID().slice(0, 8)}` }) {
    const estIn = estimateInputTokens(system, content);
    const next = worst(estIn, maxTokens);
    const all = ledger.summary();
    const ses = ledger.summary((i) => i.sessionId === sessionId);
    if (all.countedUsd + next > caps.tranche || ses.countedUsd + next > caps.session) {
      ledger.record({ kind: 'refused', sessionId, role, model, next, countedAll: all.countedUsd, countedSession: ses.countedUsd });
      throw new ModelError('BUDGET_EXCEEDED', `Budget limit reached: $${all.countedUsd.toFixed(4)} counted so far (this session $${ses.countedUsd.toFixed(4)}); the next call could cost up to $${next.toFixed(4)} and would exceed the cap ($${caps.tranche} for this work package / $${caps.session} per session). Nothing was sent.`, { retryable: false, worstUsd: next });
    }
    ledger.record({ kind: 'reserve', sessionId, instanceId, role, promptVersion, model, worstUsd: next, estIn, maxTokens });
    const t0 = Date.now();
    const apiContent = content.map(({ w, h, ...b }) => b);
    let msg;
    try {
      // messages.create (not .parse): the SDK's parse throws on a truncated/invalid output before usage and
      // stop_reason reach us. We parse ourselves so a received-but-unusable output keeps its real usage.
      const { parse: _ignored, ...format } = zodOutputFormat(schema);
      msg = await api.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: apiContent }],
        output_config: { format },
      }, { signal });
    } catch (e) {
      const aborted = e?.name === 'APIUserAbortError' || signal?.aborted;
      const status = e?.status;
      // Known rejection by the API (rate limit / overloaded / unavailable): nothing was produced; safe to retry once.
      const retryable = !aborted && [429, 503, 529].includes(status);
      // The API answered with an error status (bad request, auth/billing, rate limit, overloaded): the request was
      // rejected before any tokens were produced, so its cost is known to be zero and the reservation is released.
      // Only an abort or a connection-level failure (no response) leaves the usage genuinely unknown.
      const unknownUsage = aborted || typeof status !== 'number';
      const code = aborted ? 'ABORTED' : status ? `API_${status}` : e?.name === 'APIConnectionTimeoutError' ? 'TIMEOUT' : e?.name === 'APIConnectionError' ? 'CONNECTION' : 'CLIENT_ERROR';
      ledger.record({ kind: 'settle', sessionId, instanceId, role, model, status: aborted ? 'aborted' : 'error', code, usd: 0, usdUnknown: unknownUsage, httpStatus: status, error: String(e?.message || e).slice(0, 300), ms: Date.now() - t0 });
      throw new ModelError(code, aborted ? 'The call was stopped' : `The model call failed: ${String(e?.message || e).slice(0, 160)}`, { retryable, usdUnknown: unknownUsage, worstUsd: next, instanceId, outcomeUnknown: !aborted && !status });
    }
    const usd = costOf(model, msg.usage);
    const base = { sessionId, instanceId, role, promptVersion, model, requestId: msg._request_id, stop: msg.stop_reason, usage: msg.usage, usd, usdUnknown: false, ms: Date.now() - t0 };
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed = null; let parseProblem = null;
    if (msg.stop_reason !== 'end_turn') parseProblem = msg.stop_reason === 'max_tokens' ? `the output was truncated at the length limit (max_tokens=${maxTokens})` : `stop_reason=${msg.stop_reason}`;
    else {
      try {
        const r = schema.safeParse(JSON.parse(text));
        if (r.success) parsed = r.data; else parseProblem = `schema: ${r.error.issues.slice(0, 4).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
      } catch (err) { parseProblem = `JSON: ${String(err.message).slice(0, 120)}`; }
    }
    if (parseProblem) {
      ledger.record({ kind: 'settle', ...base, status: 'invalid', reason: parseProblem });
      throw new ModelError('OUTPUT_INVALID', `The output did not pass the program's checks: ${parseProblem}`, { repairable: true, truncated: msg.stop_reason === 'max_tokens', problems: [parseProblem], usd, instanceId, usage: msg.usage, ms: base.ms });
    }
    const problems = validate ? validate(parsed) : [];
    if (problems.length) {
      ledger.record({ kind: 'settle', ...base, status: 'invalid', reason: problems.join('; ').slice(0, 500) });
      throw new ModelError('OUTPUT_INVALID', `The output did not pass the program's checks: ${problems.join('; ').slice(0, 200)}`, { repairable: true, problems, usd, instanceId, usage: msg.usage, ms: base.ms, output: parsed });
    }
    ledger.record({ kind: 'settle', ...base, status: 'ok' });
    return { output: parsed, instanceId, usage: msg.usage, usd, ms: base.ms, model, requestId: msg._request_id };
  }
  return { call, model, mode: 'live' };
}

// Stub model for exception-path checks only (no network). Results are produced by `handlers[role]`, which may be
// async and may ignore the abort signal on purpose (to emulate a late provider response). Sessions run with it are
// marked modelMode "stub" and kept apart from live evidence.
export function createStubModel({ ledger, sessionId, handlers }) {
  async function call({ role, promptVersion, validate, signal, instanceId = `i-${randomUUID().slice(0, 8)}`, content }) {
    ledger.record({ kind: 'reserve', sessionId, instanceId, role, promptVersion, model: 'stub', worstUsd: 0 });
    const t0 = Date.now();
    let output;
    try {
      output = await handlers[role]({ signal, content });
    } catch (e) {
      ledger.record({ kind: 'settle', sessionId, instanceId, role, model: 'stub', status: 'error', usd: 0, usdUnknown: false, error: String(e.message) });
      throw e instanceof ModelError ? Object.assign(e, { instanceId }) : new ModelError(e.code || 'STUB_ERROR', String(e.message), { retryable: !!e.retryable, instanceId });
    }
    const problems = validate ? validate(output) : [];
    if (problems.length) {
      ledger.record({ kind: 'settle', sessionId, instanceId, role, model: 'stub', status: 'invalid', usd: 0, usdUnknown: false });
      throw new ModelError('OUTPUT_INVALID', `The output did not pass the program's checks: ${problems.join('; ')}`, { repairable: true, problems, usd: 0, instanceId });
    }
    ledger.record({ kind: 'settle', sessionId, instanceId, role, model: 'stub', status: 'ok', usd: 0, usdUnknown: false, ms: Date.now() - t0 });
    return { output, instanceId, usage: null, usd: 0, ms: Date.now() - t0, model: 'stub' };
  }
  return { call, model: 'stub', mode: 'stub' };
}

export const imageBlock = (buf, mediaType = 'image/png', w, h) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') }, w, h });
