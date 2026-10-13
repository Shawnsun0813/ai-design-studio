// Selector scope for a region whose CSS file is shared with the rest of the page (W5).
// The execution layer already limits *which files* a task may write. In a real project one stylesheet usually
// styles many regions, so a file allowlist alone would let a task on one region restyle another. This module
// answers one question before anything is written: does this patch only touch rules that belong to the region?
//
// It is deliberately small: a brace matcher over the file (no CSS engine), comparing rule blocks before and after.
// If it cannot parse something, it says so and the caller refuses the write rather than guessing.

// Removes comments from a slice of CSS without touching anything inside a string (so `[data-x="/*"]` and
// url("…/*…") survive). Used on a rule's prelude: a comment written just before a rule is not part of its selector,
// and its words — commas especially — must never be read as selectors.
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Splits a stylesheet into rule blocks. At-rules that contain rules (@media, @supports, @layer, @container) are
// recursed into, so `@media (...) { .brand { ... } }` yields `.brand` with its at-rule context.
export function parseRules(css, context = '', offset = 0) {
  const rules = [];
  let i = 0;
  let selStart = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end === -1 ? css.length : end + 2; continue; }
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < css.length && css[i] !== q) i += css[i] === '\\' ? 2 : 1; i++; continue; }
    if (ch === ';') { selStart = i + 1; i++; continue; } // at-statement such as @import or @charset
    if (ch === '{') {
      const prelude = css.slice(selStart, i);
      const selector = stripComments(prelude).trim();
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        const c = css[j];
        if (c === '/' && css[j + 1] === '*') { const end = css.indexOf('*/', j + 2); j = end === -1 ? css.length : end + 2; continue; }
        if (c === '"' || c === "'") { const q = c; j++; while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1; j++; continue; }
        if (c === '{') depth++;
        if (c === '}') depth--;
        j++;
      }
      if (depth !== 0) return { rules, error: `unbalanced braces after "${selector.slice(0, 40)}"` };
      const body = css.slice(i + 1, j - 1);
      if (selector.startsWith('@') && /\{/.test(body)) {
        const inner = parseRules(body, context ? `${context} ${selector}` : selector, offset + i + 1);
        if (inner.error) return { rules, error: inner.error };
        rules.push(...inner.rules);
      } else {
        rules.push({ selector, context, body: body.replace(/\s+/g, ' ').trim(), prelude: prelude.trim(), start: offset + selStart, end: offset + j });
      }
      i = j;
      selStart = i;
      continue;
    }
    i++;
  }
  return { rules, error: null };
}

const key = (r) => `${r.context}||${r.selector.replace(/\s+/g, ' ').trim()}`;

// Which rules differ between two versions of a stylesheet (added, removed or changed declarations).
// A real stylesheet repeats the same selector (a later rule overriding an earlier one), so rules are grouped by
// selector and compared as a list — otherwise a change to the first of two identical selectors would go unseen.
export function changedRules(beforeCss, afterCss) {
  const a = parseRules(beforeCss);
  const b = parseRules(afterCss);
  if (a.error || b.error) return { error: a.error || b.error, changed: [] };
  const group = (rules) => {
    const m = new Map();
    for (const r of rules) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const before = group(a.rules);
  const after = group(b.rules);
  const changed = [];
  for (const [k, list] of after) {
    const was = before.get(k) ?? [];
    if (!was.length) { changed.push({ ...list[0], how: 'added' }); continue; }
    const n = Math.max(was.length, list.length);
    for (let i = 0; i < n; i++) {
      const x = was[i];
      const y = list[i];
      if (!x) { changed.push({ ...y, how: 'added' }); continue; }
      if (!y) { changed.push({ ...x, how: 'removed' }); continue; }
      if (x.body !== y.body) changed.push({ ...y, how: 'changed' });
    }
  }
  for (const [k, list] of before) if (!after.has(k)) changed.push({ ...list[0], how: 'removed' });
  return { error: null, changed };
}

// A selector belongs to the region when every class it mentions is either one of the region's own classes or a
// registered page-level modifier (such as a layout class), and at least one of the region's classes appears.
// A rule with no class at all (an element or global rule) is never in scope.
export function selectorInScope(selector, { allowed, modifiers = [] }) {
  const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((part) => {
    const classes = part.match(/\.[-\w]+/g) ?? [];
    if (!classes.length) return false;
    if (classes.some((c) => !allowed.includes(c) && !modifiers.includes(c))) return false;
    return classes.some((c) => allowed.includes(c));
  });
}

// The whole check: apply the edits in memory, then make sure only in-scope rules moved.
// `edits` use the same contract as the execution layer: each `find` must occur exactly once.
const VERB = { added: 'add', removed: 'remove', changed: 'change' };

// `inScope` decides whether a changed rule belongs to this region. The default is the class allowlist the
// CSS-only path uses; M1 passes `selectorTargetsRegion`, which asks what the rule actually styles.
// `ignoreOtherFiles` is for a patch that also edits the component: those edits are checked elsewhere.
export function checkPatchScope({ before, edits, allowed, modifiers = [], file, inScope, ignoreOtherFiles = false }) {
  const scoped = inScope ?? ((sel) => selectorInScope(sel, { allowed, modifiers }));
  if (!inScope && !allowed?.length) return { ok: true, skipped: 'no selector scope registered for this region' };
  let after = before;
  for (const e of edits) {
    if (e.file && file && e.file !== file) {
      if (ignoreOtherFiles) continue;
      return { ok: false, reason: `edit targets ${e.file}, not ${file}` };
    }
    const parts = after.split(e.find);
    if (parts.length !== 2) return { ok: false, reason: `an edit's "find" does not occur exactly once (${parts.length - 1} matches); the execution layer will refuse it` };
    after = parts.join(e.replace);
  }
  const { error, changed } = changedRules(before, after);
  if (error) return { ok: false, reason: `the stylesheet could not be parsed for the scope check: ${error}` };
  // "the patch would added .r5-rail" read badly in the W5 evidence; the structured `how` stays as it is.
  const outside = changed.filter((r) => !scoped(r.selector));
  return outside.length
    ? { ok: false, outside: outside.map((r) => ({ selector: r.selector, context: r.context, how: r.how })), reason: `the patch would ${outside.map((r) => `${VERB[r.how] ?? r.how} ${r.context ? `${r.context} ` : ''}${r.selector}`).join('; ')}, which is outside this region's selectors` }
    : { ok: true, changed: changed.map((r) => `${r.how} ${r.selector}`) };
}

// ---- Which element a rule actually styles ----
//
// Looking for the region's class anywhere in the selector is not a boundary. `.site-header ~ *` names the region
// and styles everything after it; `:not(.site-header)` names it and styles everything else. Both passed the check
// above. What matters is the selector's *subject* — the element it sets properties on — and whether that element
// is inside the region: either a region element itself, or a descendant of one with no sibling hop in between.
const PSEUDO_ARGS = /:(?:not|is|where|has|matches|any)\((?:[^()]|\([^()]*\))*\)/gi;

// Commas inside :not(a, b) or [attr="a,b"] do not separate selectors.
export function splitSelectorList(selector) {
  const parts = [];
  let depth = 0; let quote = ''; let buf = '';
  for (const ch of selector) {
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

// [{ comb, text }] — `comb` is the combinator that links this compound to the one before it.
function compounds(part) {
  const out = []; let buf = ''; let comb = ''; let depth = 0; let quote = '';
  const push = () => { if (buf.trim()) out.push({ comb, text: buf.trim() }); buf = ''; };
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) { push(); comb = ch; continue; }
    if (depth === 0 && /\s/.test(ch)) {
      if (buf.trim()) { push(); comb = ' '; }
      continue;
    }
    buf += ch;
  }
  push();
  return out;
}

export function selectorTargetsRegion(selector, { classes = [], modifiers = [] } = {}) {
  const isRegion = (text) => {
    const bare = text.replace(PSEUDO_ARGS, ''); // a class named only inside :not()/:is() is not what this styles
    const cs = bare.match(/\.[-\w]+/g) ?? [];
    return cs.some((c) => classes.includes(c));
  };
  const parts = splitSelectorList(selector);
  if (!parts.length) return false;
  return parts.every((part) => {
    const cs = compounds(part);
    if (!cs.length) return false;
    if (isRegion(cs.at(-1).text)) return true; // the subject is a region element
    for (let i = cs.length - 1; i > 0; i--) {
      if (cs[i].comb === '~' || cs[i].comb === '+') return false; // the subject is a sibling of the region, not inside it
      if (isRegion(cs[i - 1].text)) return true; // a region ancestor, reached only by descendant/child combinators
      if (modifiers.length && (cs[i - 1].text.match(/\.[-\w]+/g) ?? []).every((c) => modifiers.includes(c))) continue;
    }
    return false;
  });
}
