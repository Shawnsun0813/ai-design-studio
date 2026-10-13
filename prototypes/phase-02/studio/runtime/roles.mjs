// Runtime role methods for the six team responsibilities (P02-R01–R06): versioned prompt + output schema +
// semantic validator. The program — not the model — decides routing, effective decisions and write permission.
// W4: all user-facing output in English (P02-L02; the user's own words are quoted as written), round-2 inputs for the
// project manager / creative lead / visual & interaction designer, and a fix mode for the implementer.
import { z } from 'zod';
import { checkCss, checkSpecRules, checkPromises } from './capabilities.mjs';

const LANGUAGE = `Write every user-facing text field in plain, natural English, even if the user wrote in another language; when you refer to the user's own words, quote them exactly as written.`;
const PRECEDENCE = `Order of authority: (1) the user's words and the confirmed preserved items, (2) the existing site's own style, (3) the references, (4) your general design taste. Never override a higher level with a lower one. Write for an ordinary site owner: short, concrete, no design jargon without a plain explanation. Keep every text field to one or two short sentences; do not repeat the same point across fields. ${LANGUAGE} CSS, class names and numbers stay as they are.`;
const SCOPE = `Scope of this session: ONE registered region of the user's running site. Only the region's CSS file may be changed automatically; its markup/text (TSX) is read-only, other regions must not change.`;
const ROLES = ['ref', 'lead', 'visual', 'impl', 'review'];

// ---------- Project manager (P02-R01) ----------
export const pmBrief = {
  role: 'pm',
  promptVersion: 'pm-brief@3',
  system: `You are the project manager of a small design team. ${SCOPE}
Round 1: you receive the user's request, whether a reference image was given, the region's source and a screenshot. Set mode "initial".
Later rounds: you receive the user's feedback on the CURRENT running version, the previous round's handoff (chosen direction and numbered completion criteria), the last review and the adopted version (if any). Decide the mode: "adjust" when the feedback can be met within the chosen direction (the visual & interaction designer refines it directly; no new proposals), or "new-direction" when the user asks for a substantially different direction (the creative lead proposes again and the user chooses). List exactly what changes this round, what must stay (things the user is satisfied with, plus earlier preserved items), and which earlier criteria ids are replaced by the feedback ("supersedes").
Always: plan this round's tasks in order, listing exactly the roles that round needs — round 1: ref, lead, visual, impl, review (all five); an "adjust" round: visual, impl, review (the reference reading and the chosen direction are inherited, not redone); a "new-direction" round: lead, visual, impl, review. Then write 1–4 goal-level completion conditions taken straight from the user's words that can be checked on the running page (no invented requirements), say what is outside the allowed scope, and write a short status message to the user (who works next, what the user will be asked to decide). You do not choose a design and never decide for the user. ${PRECEDENCE}`,
  schema: z.object({
    mode: z.enum(['initial', 'adjust', 'new-direction']),
    restatement: z.string(),
    changes: z.array(z.string()).describe('what changes this round; empty in round 1'),
    plan: z.array(z.object({ role: z.enum(['ref', 'lead', 'visual', 'impl', 'review']), task: z.string(), deliverable: z.string() })),
    goalCriteria: z.array(z.object({ text: z.string(), howToCheck: z.string() })),
    keep: z.array(z.string()),
    supersedes: z.array(z.string()).describe('ids of earlier completion criteria replaced by this feedback; empty in round 1'),
    outOfScope: z.array(z.string()),
    statusForUser: z.string(),
  }),
  validator: ({ round, previousCriteriaIds = [] }) => (o) => {
    const p = [];
    const roles = new Set(o.plan.map((x) => x.role));
    if (round === 1) {
      if (o.mode !== 'initial') p.push('round 1 must use mode "initial"');
      for (const r of ROLES) if (!roles.has(r)) p.push(`plan misses role ${r}`);
    } else {
      if (o.mode === 'initial') p.push('later rounds must use mode "adjust" or "new-direction"');
      for (const r of ['visual', 'impl', 'review', ...(o.mode === 'new-direction' ? ['lead'] : [])]) if (!roles.has(r)) p.push(`plan misses role ${r}`);
      if (o.changes.length === 0) p.push('changes is empty');
      const bad = o.supersedes.filter((id) => !previousCriteriaIds.includes(id));
      if (bad.length) p.push(`supersedes has unknown ids: ${bad.join(', ')}`);
    }
    if (o.goalCriteria.length < 1 || o.goalCriteria.length > 4) p.push(`goalCriteria must have 1-4 items, got ${o.goalCriteria.length}`);
    if (o.keep.length === 0) p.push('keep is empty');
    if (!o.statusForUser.trim()) p.push('statusForUser is empty');
    return p;
  },
};

// ---------- Reference research (P02-R02) ----------
export const interpret = {
  role: 'ref',
  promptVersion: 'ref-interpret@4',
  system: `You are the reference researcher. ${SCOPE} You receive the user's goal, the project manager's restatement and keep list, a screenshot of the region as it is now, the region's source, and either one reference image or the statement that the user has no reference. With a reference: explain precisely what to borrow and what NOT to borrow, each tied to a visible aspect (layout, proportion, hierarchy, spacing, colour, type, interaction) and to a concrete place in the current region. Without a reference: describe which rules of the existing site/region should be continued ("borrow" = rules taken from the current site itself) and what should be avoided. Always list what must be kept (merge the project manager's keep list; be concrete, e.g. aria attributes, text content). If the user corrected an earlier interpretation, follow the correction exactly and say in "correctionApplied" how. Do not propose a design yet. If the goal, or the reference, asks for something this region cannot be given (the limits are listed in the input), say so in "cannotDoHere" in one plain sentence each, addressed to the user — what they asked for, and what is possible here instead. Never quietly replace what they asked for with something easier and say nothing. ${PRECEDENCE}`,
  schema: z.object({
    mode: z.enum(['reference', 'no-reference']),
    borrow: z.array(z.object({ aspect: z.string(), rule: z.string(), appliesTo: z.string() })),
    skip: z.array(z.object({ aspect: z.string(), reason: z.string() })),
    keep: z.array(z.string()),
    correctionApplied: z.string().describe('empty string unless the user corrected an earlier interpretation'),
    cannotDoHere: z.array(z.string()).describe("things the goal or reference implies that this region cannot deliver, in plain words for the user; empty array if there are none"),
    openQuestion: z.string().describe('one question for the user if something is genuinely ambiguous, else empty string'),
  }),
  // If the goal itself asks for something out of reach, the user hears it here — before directions are drawn up
  // and long before anything is written.
  validator: ({ hasReference, correction, goal = '', region }) => (o) => [
    ...(region && checkPromises({ texts: [goal], region }).length && !o.cannotDoHere.length
      ? ['the goal asks for something this region cannot deliver, but cannotDoHere is empty: tell the user plainly what is not possible here and what is'] : []),
    ...(o.cannotDoHere.some((x) => !String(x).trim()) ? ['cannotDoHere has an empty entry'] : []),
    ...(o.mode !== (hasReference ? 'reference' : 'no-reference') ? [`mode must be ${hasReference ? 'reference' : 'no-reference'}`] : []),
    ...(o.borrow.length === 0 ? ['no borrow items'] : []),
    ...(hasReference && o.skip.length === 0 ? ['no skip items'] : []),
    ...(o.keep.length === 0 ? ['no keep items'] : []),
    ...(correction && !o.correctionApplied.trim() ? ['correctionApplied is empty although the user gave a correction'] : []),
  ],
};

// ---------- Creative lead (P02-R03) ----------
export const propose = {
  role: 'lead',
  promptVersion: 'lead-propose@3',
  system: `You are the creative lead. ${SCOPE} Propose 2 clearly different directions (3 only if the goal is genuinely open) for the region, based ONLY on the user's goal or feedback, the confirmed interpretation and the preserved items. In a later round you start from the CURRENT running version and the user asked for a different direction: say how each option differs from the current one. If the user rejected earlier proposals, address the stated reason. Each direction lists concrete visible changes (numbers where useful), how it uses the reference (or the existing site), and what it promises to keep. Each comes with previewCss: plain CSS rules that preview the direction; it is injected inside "@scope ([data-region-id=…])" so selectors must target classes inside the region (e.g. .info-title); use :scope for the region root. No @import, no url(), no web fonts. **Every direction must be deliverable within the limits listed in the input; a direction that needs anything outside them is not an option — do not offer it, and say in the "why" field what had to be left out.** Recommend one in one sentence — the user decides. ${PRECEDENCE}`,
  schema: z.object({
    proposals: z.array(z.object({
      id: z.string().describe('A, B or C'),
      name: z.string(),
      intent: z.string(),
      changes: z.array(z.string()),
      referenceUse: z.string(),
      keepPromise: z.string(),
      previewCss: z.string(),
    })),
    recommended: z.string(),
    why: z.string(),
  }),
  // `region` is passed in so a proposal that promises something the execution layer cannot write is caught here,
  // before the user is asked to choose and before anyone waits for it.
  validator: ({ region }) => (o) => {
    const p = [];
    if (o.proposals.length < 2 || o.proposals.length > 3) p.push(`expected 2-3 proposals, got ${o.proposals.length}`);
    const ids = o.proposals.map((x) => x.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !/^[ABC]$/.test(id))) p.push(`proposal ids must be distinct A/B/C, got ${ids.join(',')}`);
    for (const x of o.proposals) {
      if (/@import|url\(|<\/style/i.test(x.previewCss)) p.push(`${x.id}: previewCss uses @import/url()`);
      if (!/\{[^}]*:[^}]*\}/.test(x.previewCss)) p.push(`${x.id}: previewCss has no rules`);
      if (x.changes.length === 0) p.push(`${x.id}: no changes listed`);
      if (region) for (const problem of checkCss({ css: x.previewCss, region, preview: true })) p.push(`${x.id}: ${problem}`);
      // The words the user reads must promise the same thing the preview can show (W5: direction B's text
      // sold a sweep on load while its CSS was being refused rule by rule).
      if (region) for (const problem of checkPromises({ texts: [x.name, x.intent, ...x.changes, x.keepPromise], region })) p.push(`${x.id}: ${problem}`);
    }
    if (!ids.includes(o.recommended)) p.push('recommended id not among proposals');
    return p;
  },
};

// ---------- Visual & interaction designer (P02-R04) ----------
export const refine = {
  role: 'visual',
  promptVersion: 'visual-spec@2',
  system: `You are the visual & interaction designer. ${SCOPE} The user chose ONE direction (possibly with a modification in their own words). In a later round you start from the CURRENT running version: specify ONLY what this round changes (the project manager lists the changes and what must stay); everything else must remain exactly as it is now. Turn it into an exact specification the implementer can follow and the reviewer can check: concrete CSS rules (selector inside the region, property, value, why), the key interaction states (e.g. the details toggle collapsed/expanded, hover/focus) and how they must look, and 3–8 completion criteria that are visible on the running page at stated widths (1440px and 900px viewports). The user's words override the chosen proposal wherever they conflict; say explicitly how you applied them. Keep every preserved item; do not add changes the round does not ask for. Only use selectors for classes that exist in the region; a page-level modifier class (listed with the region, e.g. a layout class) may prefix them for responsive rules, but every selector must still target the region. **Stay inside the limits listed in the input: no animation (there is no way to add @keyframes here), no new markup, text or interaction.** ${PRECEDENCE}`,
  schema: z.object({
    summary: z.string(),
    modificationApplied: z.string().describe('how the user modification or feedback is reflected; empty string if there was none'),
    rules: z.array(z.object({ selector: z.string(), property: z.string(), value: z.string(), why: z.string() })),
    states: z.array(z.object({ state: z.string(), spec: z.string() })),
    criteria: z.array(z.object({ text: z.string(), width: z.string().describe('"1440", "900" or "both"'), howToCheck: z.string() })),
  }),
  // A selector may lean on a page-level modifier the region registers (a layout or theme class such as .layout-n),
  // as long as it still targets the region itself. That is exactly what the execution layer allows at write time;
  // refusing it here would reject a legitimate responsive rule and send the designer back for no reason.
  validator: ({ classes, modifiers = [], modification, region }) => (o) => {
    const p = [];
    const mods = modifiers.map((m) => m.replace(/^\./, ''));
    if (o.rules.length === 0) p.push('no rules');
    if (o.criteria.length < 3 || o.criteria.length > 8) p.push(`criteria must have 3-8 items, got ${o.criteria.length}`);
    for (const r of o.rules) {
      const used = [...r.selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      const bad = used.filter((c) => !classes.includes(c) && !mods.includes(c));
      if (bad.length) p.push(`selector "${r.selector}" uses classes not in the region: ${bad.join(', ')}`);
      else if (used.length && !used.some((c) => classes.includes(c))) p.push(`selector "${r.selector}" only uses page-level classes (${used.join(', ')}); it must target this region`);
    }
    if (region) for (const problem of checkSpecRules({ rules: o.rules, region })) p.push(problem);
    // A criterion the page can never satisfy would send the reviewer looking for it forever.
    if (region) for (const problem of checkPromises({ texts: [o.summary, o.modificationApplied, ...o.states.map((x) => x.spec), ...o.criteria.map((x) => x.text)], region })) p.push(problem);
    if (modification && !o.modificationApplied.trim()) p.push('modificationApplied is empty although the user gave a modification');
    return p;
  },
};

// ---------- Implementer (P02-R05) ----------
export const implement = {
  role: 'impl',
  promptVersion: 'impl-patch@3',
  system: `You are the implementer. You receive a handoff (goal, chosen direction with the user's words, reference use, preserved items, the visual spec and the frozen completion criteria) and the CURRENT content of the only file you may change. In fix mode you also receive the reviewer's located deviations and fix conditions: fix exactly those, nothing else. Output exact find/replace edits against that file. Each "find" must be copied verbatim from the current content and occur exactly once. Change nothing that is not asked; keep everything listed as preserved. If the task cannot be met by editing this file alone, return no edits and explain in "blocked". Write "notes" and "blocked" in plain English.`,
  schema: z.object({
    edits: z.array(z.object({ file: z.string(), find: z.string(), replace: z.string() })),
    notes: z.string(),
    blocked: z.string().describe('empty string unless the task cannot be done within the allowed file'),
  }),
  // The edits are applied in memory and the result checked against what this region can carry, so a patch that
  // would be refused at the write step (an @keyframes block, a shared class) comes back here as a readable
  // problem the implementer can repair. Only problems the edits introduce count: the rest of the stylesheet
  // belongs to other regions and is none of this round's business.
  validator: (allowedFiles, current, region) => (o) => {
    const p = [];
    if (o.blocked) return p;
    if (o.edits.length === 0) p.push('no edits');
    const text = current.replace(/\r\n/g, '\n');
    let applied = text;
    for (const e of o.edits) {
      if (!allowedFiles.includes(e.file)) p.push(`edit targets non-allowed file ${e.file}`);
      const n = text.split(e.find).length - 1;
      if (n !== 1) p.push(`find occurs ${n} times: ${JSON.stringify(e.find.slice(0, 50))}`);
      else applied = applied.replace(e.find, () => e.replace);
    }
    if (region && p.length === 0) {
      const had = new Set(checkCss({ css: text, region }));
      for (const problem of checkCss({ css: applied, region })) if (!had.has(problem)) p.push(problem);
    }
    return p;
  },
};

// ---------- Partner / design reviewer (P02-R06) ----------
export const review = {
  role: 'review',
  promptVersion: 'review@3',
  system: `You are the independent design reviewer. You did not implement this change and must not trust the implementer's explanation. Judge the REAL running page from the evidence: before/after screenshots of the region at the same viewport widths (1440 and 900; "before" is the version this round started from), after screenshots with the details toggle expanded, before/after screenshots of the preserved neighbouring panel, the program's interaction and technical check results, computed-style changes and the actual diff for this round. Check each frozen completion criterion one by one — including the criteria carried over from earlier rounds and the preserved items: pass / fail / unclear, citing the visible evidence (which image, which element). Report every deviation you can locate: the element (class), the property or visible effect, the width, the impact for the user, and a concrete fix condition that stays within the allowed CSS file (say so if a fix would need markup changes). Report changes outside the requested scope. Never lower, reinterpret or add criteria. You judge technical correctness and match with the chosen direction separately; you never decide whether the user adopts or likes the result. ${LANGUAGE}`,
  schema: z.object({
    criteria: z.array(z.object({ id: z.string(), verdict: z.enum(['pass', 'fail', 'unclear']), evidence: z.string() })),
    deviations: z.array(z.object({ element: z.string(), property: z.string(), width: z.string(), what: z.string(), impact: z.string(), fix: z.string() })),
    outOfScope: z.array(z.string()),
    directionMatch: z.enum(['pass', 'fail', 'unclear']),
    summary: z.string(),
  }),
  validator: (criteriaIds) => (o) => {
    const got = new Set(o.criteria.map((c) => c.id));
    const p = criteriaIds.filter((id) => !got.has(id)).map((id) => `criterion ${id} not judged`);
    const extra = o.criteria.filter((c) => !criteriaIds.includes(c.id)).map((c) => `unknown criterion ${c.id}`);
    return [...p, ...extra];
  },
};



// Whole-line `//` comments and `/* */` blocks. Inline `//` is left alone on purpose: it is usually a URL.
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ 	]*\/\/.*$/gm, ' ');

// ---------- M1: one call that understands, decides and writes (D-028) ----------
//
// W5 ran six calls before the page moved once. For M1 the same responsibilities are carried by a single
// instance: it reads the goal, the region as it runs now, its component and styles, and returns both the
// design decision in the user's terms and the exact edits. The responsibilities are still shown separately in
// the workbench, attributed to this one instance — not pretended to be six workers.
//
// What keeps it safe is unchanged and sits outside the model: the file allowlist, the baseline hash, the
// must-keep anchors, the type check, the evidence on the running page and the version history.
export const build = {
  role: 'impl',
  promptVersion: 'm1-build@1',
  system: `You are one experienced product designer who also writes the code, working on ONE region of a real, running site. You do the whole job in one pass: understand what the owner asked for, decide the design, and produce the exact edits.

You may change only the files listed in the input (the region's component and its styles). Everything else — other components, other regions, data, routing, behaviour, dependencies — is off limits. Do not add a package: if an icon is needed, draw a small inline SVG in the same style the file already uses, with aria-hidden="true" next to a real text label.

Hold to these rules, which the program checks after you:
- Keep every listed preserved item. An icon may sit BESIDE a label, never replace it. No control may lose its visible text or its accessible name (aria-label, role, aria-controls, label association, aria-live).
- "Simpler" means better grouping, rhythm, hierarchy, spacing and weight — not deleting content or features. If something genuinely should be less prominent, make it quieter or fold it into the existing disclosure; do not remove it.
- No new animation: no @keyframes, no animation property. A transition on hover or focus is fine.
- Every "find" must be copied verbatim from the current file content you were given and must occur exactly once in that file. Keep each edit small and surgical; do not restate the whole file.
- The component is TypeScript + React 19. It must still type-check: keep imports, props and hooks valid.

Write every user-facing field in plain English for a site owner, not for a developer: say what will look different and why, not which selector you touched. ${LANGUAGE}`,
  schema: z.object({
    understanding: z.string().describe("the owner's goal in your own words, one or two sentences"),
    approach: z.string().describe('the design decision you took and why it fits this site, one or two sentences'),
    changes: z.array(z.object({ what: z.string(), why: z.string() })).describe('3-8 concrete, visible changes'),
    icons: z.array(z.object({ label: z.string(), icon: z.string(), why: z.string() })).describe('each control that now has an icon beside its label; empty if none'),
    keep: z.array(z.string()).describe('the preserved items you held to'),
    edits: z.array(z.object({ file: z.string(), find: z.string(), replace: z.string() })),
    checks: z.array(z.string()).describe('what someone should look at on the running page to judge this, 3-6 items'),
    notes: z.string().describe('anything the owner should know, including what you deliberately did not do; empty string if nothing'),
  }),
  // Program checks only — no second model call. They are the same kind of guard the CSS-only path had, moved
  // to what a component edit can get wrong: the wrong file, an anchor that is not unique, a dependency smuggled
  // in, an accessible name or a piece of content quietly dropped, or animation that was asked not to be added.
  validator: ({ allowedFiles, current, mustKeep = {}, forbid = [] }) => (o) => {
    const p = [];
    if (!o.edits.length) p.push('no edits');
    const applied = { ...current };
    for (const e of o.edits) {
      if (!allowedFiles.includes(e.file)) { p.push(`edit targets ${e.file}, which this task may not change (allowed: ${allowedFiles.join(', ')})`); continue; }
      const text = applied[e.file] ?? '';
      const n = text.split(e.find).length - 1;
      if (n !== 1) { p.push(`in ${e.file} the "find" text occurs ${n} times, so it is not a safe anchor: ${JSON.stringify(e.find.slice(0, 60))}`); continue; }
      applied[e.file] = text.replace(e.find, () => e.replace);
    }
    if (p.length) return p;
    for (const [file, anchors] of Object.entries(mustKeep)) {
      if (applied[file] === undefined) continue;
      // Comments mention the same words ("… search, freshness and corrections, Copy link …"), so a label could
      // be deleted from the markup while the file still contained the text. Only live code counts.
      const was = withoutComments(current[file] ?? '');
      const now = withoutComments(applied[file]);
      for (const a of anchors) {
        if (was.includes(a) && !now.includes(a)) p.push(`"${a}" disappeared from ${file}; the header must keep its content and accessible names (an icon goes beside a label, not instead of it)`);
      }
    }
    const count = (text, needle) => text.split(needle).length - 1;
    for (const [file, text] of Object.entries(applied)) {
      // This stylesheet already animates other parts of the page, so "the file contains it" proves nothing:
      // what matters is that this patch does not add more.
      for (const bad of forbid) if (count(text, bad) > count(current[file] ?? '', bad)) p.push(`${file} adds ${bad}: this round does not add animation (a transition on hover or focus is fine)`);
      // A new bare import means a new dependency, which this task may not install.
      for (const m of text.matchAll(/^\s*import\s[^\n]*?from\s+['"]([^'".][^'"]*)['"]/gm)) {
        if (!(current[file] ?? '').includes(m[0].trim())) p.push(`${file} imports "${m[1]}", a package this task may not add; draw an inline SVG instead`);
      }
    }
    return p;
  },
};

export const ROLE_METHODS = { pm: pmBrief, ref: interpret, lead: propose, visual: refine, impl: implement, review, build };
