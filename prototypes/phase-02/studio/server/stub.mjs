// Stub role outputs for exception-path checks (server started with --stub; sessions are marked modelMode "stub").
// These are NOT design work and never count as live evidence. Faults can be injected per role via
// POST /api/test/fault (stub mode only): delay (abortable), late (ignores abort, emulates a late provider response),
// fail (known API rejection, retryable), unknown (connection lost: outcome unknown), invalid (fails validation once),
// budget (the adapter's pre-call refusal). Controls: pmMode ('adjust' | 'new-direction') for later rounds,
// reviewFail ('first' = fails on the first pass and passes after a fix | 'always' | 'never').
import { ModelError } from '../runtime/model.mjs';
import { parseRules, selectorInScope } from '../runtime/css-scope.mjs';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ModelError('ABORTED', 'Call aborted', { usdUnknown: true })); }, { once: true });
});
const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const roundOf = (text) => Number(/ROUND (\d+)/.exec(text)?.[1] || /"round":(\d+)/.exec(text)?.[1] || 1);
// The stub must speak about whichever region it was given (the sample, or a W5 project), so it reads the region's
// classes out of the same prompt the real model gets instead of hard-coding the sample's.
const classesOf = (text) => {
  const root = /Region root class: ([-\w]+)/.exec(text)?.[1] ?? /Classes in the region: ([-\w]+)/.exec(text)?.[1];
  const list = (/(?:inner classes|Classes in the region): (.*)/.exec(text)?.[1] ?? '').split(',').map((x) => x.trim().replace(/^\./, '')).filter((x) => /^[-\w]+$/.test(x));
  const inner = list.filter((c) => c !== root);
  return { root: root ?? 'info-panel', inner, target: inner[0] ?? root ?? 'info-panel' };
};

const OUT = {
  pm: ({ content, control }) => {
    const r = roundOf(textOf(content));
    const mode = r === 1 ? 'initial' : control.pmMode || 'adjust';
    return {
      mode,
      restatement: r === 1 ? '(stub) Make the opening hours easy to spot.' : '(stub) Make the title a little smaller; keep the rest.',
      changes: r === 1 ? [] : ['(stub) title size down a step'],
      plan: (r === 1 ? ['ref', 'lead', 'visual', 'impl', 'review'] : mode === 'new-direction' ? ['lead', 'visual', 'impl', 'review'] : ['visual', 'impl', 'review']).map((role) => ({ role, task: `(stub) task for ${role}`, deliverable: '(stub) artifact' })),
      goalCriteria: [{ text: r === 1 ? '(stub) the title is clearly larger than body text' : '(stub) the title is one step smaller', howToCheck: '1440 screenshot' }],
      keep: ['All text content', 'Show/Hide details toggle'],
      supersedes: r === 1 ? [] : ['S1'],
      outOfScope: ['Changing the text'],
      statusForUser: '(stub model) Next, the team works on your request.',
    };
  },
  ref: ({ content }) => ({
    mode: /said there is no reference/.test(textOf(content)) ? 'no-reference' : 'reference',
    cannotDoHere: /dynamic|animat|moving|sweep/i.test((/User's goal: (.*)/.exec(textOf(content)) ?? [])[1] ?? '')
      ? ['(stub) Motion that plays by itself is not possible in this area; movement on hover or focus is.'] : [],
    borrow: [{ aspect: 'hierarchy', rule: '(stub) larger title', appliesTo: '.info-title' }],
    skip: [{ aspect: 'colour', reason: '(stub) not the dark background' }],
    keep: ['All text content', 'Show/Hide details toggle', 'The This week panel on the right'],
    correctionApplied: /correction, verbatim/.test(textOf(content)) ? '(stub) applied your correction' : '',
    openQuestion: '',
  }),
  lead: ({ content, control }) => {
    const c = classesOf(textOf(content));
    // `outOfScope` makes the lead promise an animation and a shared utility class, the way the real model did in
    // W5 session s-20261012180134-84b0. The program must catch it before the user is asked to choose.
    if (control.outOfScope) {
      if (control.outOfScope !== 'always') delete control.outOfScope; // the repair attempt stays in scope
      return {
        proposals: [
          { id: 'A', name: '(stub) Lively sweep', intent: 'Animated sheen', changes: ['Gradient sweeps on load'], referenceUse: '(stub)', keepPromise: 'Text unchanged',
            previewCss: `:scope { animation: stub-sweep 1200ms ease-out 1; }
@keyframes stub-sweep { from { opacity: .6; } to { opacity: 1; } }
.mini { border-radius: 999px; }` },
          { id: 'B', name: '(stub) Calm', intent: 'Quieter', changes: ['More spacing'], referenceUse: '(stub)', keepPromise: 'Text unchanged', previewCss: `:scope { padding: 20px; }` },
        ],
        recommended: 'A',
        why: '(stub)',
      };
    }
    return {
      proposals: [
        { id: 'A', name: '(stub) Clear hierarchy', intent: 'Larger title', changes: ['Title 15→24px'], referenceUse: 'Borrows hierarchy', keepPromise: 'Text unchanged', previewCss: `.${c.target} { font-size: 24px; }` },
        { id: 'B', name: '(stub) More space', intent: 'More padding', changes: ['Padding 12→24px'], referenceUse: 'Borrows spacing', keepPromise: 'Text unchanged', previewCss: ':scope { padding: 24px; }' },
      ],
      recommended: 'A',
      why: '(stub)',
    };
  },
  visual: ({ content }) => ({
    summary: '(stub) spec',
    modificationApplied: /words for this direction: (?!\(none\))/.test(textOf(content)) ? '(stub) applied your words' : '',
    rules: [{ selector: `.${classesOf(textOf(content)).target}`, property: 'font-size', value: '24px', why: '(stub)' }],
    states: [{ state: 'expanded', spec: '(stub) unchanged' }],
    criteria: [
      { text: '(stub) title size as specified', width: 'both', howToCheck: 'computed style' },
      { text: '(stub) panel padding 24px', width: 'both', howToCheck: 'computed style' },
      { text: '(stub) Show/Hide details works', width: 'both', howToCheck: 'interaction check' },
    ],
  }),
  impl: ({ content, control }) => {
    const text = textOf(content);
    // M1 sends one call that covers the whole job; it is dispatched by role like every other call, so it
    // arrives here. Its input looks nothing like the CSS-only handoff: it carries whole files.
    if (/Files you may change/.test(text)) return OUT.build({ content, control });
    const css = text.split('current content:\n')[1] || '';
    const once = (x) => css.split(x).length - 1 === 1;
    // the file the region actually allows, read from the same prompt the real implementer gets
    const F = /The only file you may change, ([^\s,]+),/.exec(text)?.[1] ?? 'src/components/InfoPanel.css';
    const edits = [];
    // Anchors are found in the CSS as it is now (the sample may already hold an earlier result), and every
    // "find" must occur exactly once, like a real patch.
    // A region may register a selector scope (W5: the stylesheet is shared). Then the stub edits inside it,
    // exactly like a real implementer has to.
    // `implOutOfScope` writes the patch the real implementer wrote in W5 session s-20261012180134-84b0:
    // an @keyframes block plus an animation on the region root. The region can never carry it.
    if (control.implOutOfScope) {
      if (control.implOutOfScope !== 'always') delete control.implOutOfScope;
      const root = (/these classes: ([^(,\n]*)/.exec(text)?.[1] ?? '').trim() || '.info-panel';
      const rule = parseRules(css).rules.find((r) => r.selector.trim() === root);
      if (rule) {
        const raw = css.slice(rule.start, rule.end + 1);
        if (once(raw)) return { edits: [{ file: F, find: raw, replace: `@keyframes stub-sweep { from { opacity: .7; } to { opacity: 1; } }\n${raw.replace(/\}\s*$/, 'animation: stub-sweep 1200ms ease-out 1;\n}')}` }], notes: '(stub) a sweep on load', blocked: '' };
      }
    }
    const allowed = (/these classes: ([^(\n]*)/.exec(text)?.[1] ?? '').match(/\.[-\w]+/g) ?? [];
    const modifiers = (/may prefix them: ([^)]*)\)/.exec(text)?.[1] ?? '').match(/\.[-\w]+/g) ?? [];
    if (allowed.length) {
      const inScope = parseRules(css).rules.filter((r) => selectorInScope(r.selector, { allowed, modifiers }));
      for (const r of inScope) {
        const raw = css.slice(r.start, r.end + 1);
        const m = /(padding|font-size|gap|height):\s*(\d+)px/.exec(raw);
        if (!m || !once(raw)) continue;
        const bump = m[1] === 'font-size' ? 3 : 4;
        return { edits: [{ file: F, find: raw, replace: raw.replace(m[0], `${m[1]}: ${Number(m[2]) + bump}px`) }], notes: `(stub) ${m[1]} of ${r.selector}`, blocked: '' };
      }
      return { edits: [], notes: '(stub)', blocked: "(stub) no numeric declaration found inside this region's selectors" };
    }
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px;/g)].map((m) => ({ text: m[0], n: Number(m[1]) })).filter((x) => once(x.text));
    const paddings = [...css.matchAll(/padding:\s*(\d+)px;/g)].map((m) => ({ text: m[0], n: Number(m[1]) })).filter((x) => once(x.text));
    const biggest = sizes.slice().sort((a, b) => b.n - a.n)[0];
    const smallest = sizes.slice().sort((a, b) => a.n - b.n)[0];
    if (/FIX MODE/.test(text)) {
      const pad = paddings[0];
      if (pad) edits.push({ file: F, find: pad.text, replace: `padding: ${pad.n}px ${pad.n + 4}px;` });
      else if (biggest) edits.push({ file: F, find: biggest.text, replace: `font-size: ${biggest.n + 1}px;` });
    } else if (roundOf(text) === 1) {
      if (smallest) edits.push({ file: F, find: smallest.text, replace: `font-size: ${smallest.n + 9}px;` });
      if (paddings[0]) edits.push({ file: F, find: paddings[0].text, replace: `padding: ${paddings[0].n + 12}px;` });
    } else if (biggest) {
      edits.push({ file: F, find: biggest.text, replace: `font-size: ${biggest.n - 1}px;` });
    }
    return { edits, notes: '(stub)', blocked: edits.length ? '' : '(stub) nothing to change' };
  },
  // M1 (D-028): the single call. It does what the real one must do — read the files it was given, put an icon
  // beside a label without touching the label, and adjust spacing — so the whole path can be checked with no API.
  build: ({ content, control }) => {
    const text = textOf(content);
    // `extraCss` lets a check drive one exact rule through the real write path (scope checks, baseline, undo).
    if (control?.extraCss) {
      const css = (/--- (\S+\.css) ---/.exec(text) ?? [])[1];
      const anchor = (/--- \S+\.css ---\n([^\n]+)/.exec(text) ?? [])[1];
      return {
        understanding: '(stub)', approach: '(stub)', changes: [{ what: '(stub)', why: '(stub)' }], icons: [], keep: ['(stub)'],
        edits: css && anchor ? [{ file: css, find: anchor, replace: `${control.extraCss}
${anchor}` }] : [],
        checks: ['(stub)'], notes: '(stub)',
      };
    }
    const files = {};
    for (const m of text.matchAll(/--- (\S+) ---\n([\s\S]*?)(?=\n\n--- |$)/g)) files[m[1]] = m[2];
    const tsx = Object.keys(files).find((f) => f.endsWith('.tsx'));
    const css = Object.keys(files).find((f) => f.endsWith('.css'));
    const edits = [];
    const icons = [];
    const once = (hay, needle) => hay.split(needle).length === 2;
    const ICON = (d) => `<svg className="stub-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${d}</svg>`;
    const SHAPES = ['<path d="M5 5V3h8v8h-2" fill="none" stroke="currentColor" strokeWidth="1.5" /><rect x="3" y="5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />', '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" />'];
    // An icon beside each label it can find — never instead of it, which is what the program checks.
    if (tsx) {
      let n = 0;
      for (const m of files[tsx].matchAll(/>([A-Z][^<>{}]{1,24})<\/button>/g)) {
        if (n >= 2) break;
        const anchor = m[0];
        if (!once(files[tsx], anchor)) continue;
        edits.push({ file: tsx, find: anchor, replace: `>${ICON(SHAPES[n % SHAPES.length])}<span>${m[1]}</span></button>` });
        icons.push({ label: m[1], icon: n === 0 ? 'two overlapping sheets' : 'a circular arrow', why: '(stub) the action is recognisable before the text is read' });
        n += 1;
      }
    }
    // Spacing on a rule that belongs to this component: its selector must use a class the component renders.
    if (css) {
      const root = (/Its root element is \.([-\w]+)/.exec(text) ?? [])[1] ?? '';
      const used = new Set([...(tsx ? files[tsx].matchAll(/className="([^"]+)"/g) : [])].flatMap((m) => m[1].split(/\s+/)));
      for (const m of files[css].matchAll(/(^|\n)([^@{}\n][^{}\n]*)\{([^{}]*)\}/g)) {
        const [, , selector, body] = m;
        const classes = (selector.match(/\.[-\w]+/g) ?? []).map((c) => c.slice(1));
        // Stay inside the region the way the prompt describes it: the rule must use the root class, or a class
        // the component renders when no root is named (the CSS-only sample).
        if (!classes.length) continue;
        if (root && !classes.includes(root)) continue;
        if (!root && used.size && !classes.some((c) => used.has(c))) continue;
        const rule = `${selector}{${body}}`;
        if (!once(files[css], rule)) continue;
        const gap = /gap:\s*(\d+)px/.exec(body);
        if (gap) { edits.push({ file: css, find: rule, replace: `${selector}{${body.replace(gap[0], `gap: ${Number(gap[1]) + 6}px`)}}` }); break; }
        edits.push({ file: css, find: rule, replace: `${selector}{${body.replace(/\s*$/, '')}
  gap: 18px;
}` });
        break;
      }
    }
    return {
      understanding: '(stub) Make it easier to scan and give the actions icons.',
      approach: '(stub) Keep every word, put an icon beside each action and give the groups a little more room.',
      changes: [{ what: '(stub) the actions get an icon beside the label', why: 'the action is recognisable at a glance' }, { what: '(stub) more space between the groups', why: 'it reads as groups instead of one run of text' }],
      icons,
      keep: ['(stub) every label, the existing behaviour and the panel contents'],
      edits,
      checks: ['(stub) the labels still read the same', '(stub) the disclosure still opens', '(stub) nothing outside the region moved'],
      notes: '(stub) no real design judgement here; this only exercises the path.',
    };
  },
  review: ({ content, control }) => {
    const text = textOf(content);
    const ids = [...new Set([...text.matchAll(/"id":"([GSKC]\d+)"/g)].map((m) => m[1]))];
    const reReview = /re-review after ONE fix/.test(text);
    const fail = control.reviewFail === 'always' || ((control.reviewFail ?? 'first') === 'first' && !reReview);
    return {
      criteria: ids.map((id) => ({ id, verdict: fail && id === 'S2' ? 'fail' : 'pass', evidence: '(stub)' })),
      deviations: fail ? [{ element: '.info-panel', property: 'padding', width: '1440', what: '(stub deviation)', impact: '(stub)', fix: '(stub) use 24px 28px' }] : [],
      outOfScope: [],
      directionMatch: 'pass',
      summary: reReview ? '(stub re-review)' : '(stub review)',
    };
  },
};

export function stubHandlers(control) {
  const h = {};
  for (const role of Object.keys(OUT)) {
    h[role] = async ({ signal, content }) => {
      // Checks need to see what was actually sent, not what the code meant to send (did the reference image
      // really travel with the request?). Only ever set by a check; nothing in the product reads it.
      control.record?.push({ role, content });
      const f = control.faults[role];
      if (f?.once) delete control.faults[role];
      if (f?.mode === 'late') await new Promise((r) => setTimeout(r, f.ms)); // ignores abort on purpose
      else await wait(f?.mode === 'delay' ? f.ms : 120, signal);
      if (f?.mode === 'fail') throw new ModelError('API_529', '(stub) The model service is overloaded', { retryable: true, usdUnknown: true, worstUsd: 0 });
      if (f?.mode === 'unknown') throw new ModelError('CONNECTION', '(stub) Connection lost', { retryable: false, usdUnknown: true, outcomeUnknown: true, worstUsd: 0 });
      if (f?.mode === 'budget') throw new ModelError('BUDGET_EXCEEDED', '(stub) Budget limit: the next call could exceed the cap', { retryable: false });
      if (f?.mode === 'invalid' && role === 'lead') return { proposals: [], recommended: 'A', why: '' };
      return OUT[role]({ content, control });
    };
  }
  return h;
}
