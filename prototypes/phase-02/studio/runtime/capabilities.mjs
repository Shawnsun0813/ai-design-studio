// What this region can actually be changed with — one definition, used by every step.
//
// The execution layer can only write CSS rules that belong to the region's own selectors, inside the region's
// allowed files. Until now only the write step knew that: the creative lead could propose an animation, the visual
// designer could specify it, the user could choose it and wait for it, and the refusal arrived at the very end
// (W5 session s-20261012180134-84b0: @keyframes, the shared .mini buttons, :scope rules). This module makes the
// same boundary readable (for prompts) and checkable (for validators), so a promise that cannot be kept is caught
// before the user is asked to choose.
//
// It does not widen anything: the permissions still come from the registry.
import { parseRules, selectorInScope, stripComments } from './css-scope.mjs';

// Rules the written stylesheet can carry. A preview is injected inside `@scope ([data-region-id=…])` in the page,
// so it may use :scope; the file cannot — there the region's root class stands for it.
const AT_RULES_OK = ['media', 'supports'];
const AT_RULES_NOT_OK = {
  keyframes: 'an animation needs a @keyframes block, which is a page-level name, not part of this region',
  'font-face': 'a web font is a page-level resource, not part of this region',
  import: 'importing another stylesheet is a page-level change',
  property: 'a custom property definition is page-level',
  layer: 'cascade layers are page-level',
};

export function capabilityOf(region) {
  const selectors = region.allowedSelectors ?? (region.classes ?? []).map((c) => `.${c}`);
  return {
    files: region.allowedFiles ?? [],
    selectors,
    modifiers: region.selectorModifiers ?? [],
    rootClass: selectors[0] ?? (region.classes?.[0] ? `.${region.classes[0]}` : ''),
    sourceFile: region.sourceFile,
    interaction: region.interaction ?? null,
  };
}

// The same boundary in words, for the prompts of every role.
export function capabilityText(region) {
  const c = capabilityOf(region);
  const lines = [
    `What can actually be delivered for this region (the execution layer enforces it; anything else is refused before it reaches the page):`,
    `- Only CSS, only in ${c.files.join(', ')}. ${c.sourceFile} (markup and text) is read-only: no new elements, no new icons or images, no text changes, no JavaScript, no new interactions.`,
    `- Only rules whose selector uses these classes: ${c.selectors.join(', ')}${c.modifiers.length ? ` (a page-level modifier may prefix them: ${c.modifiers.join(', ')})` : ''}. Any other class in that file — shared utilities included — belongs to another part of the page and cannot be touched.`,
    `- In the file there is no @scope wrapper: write ${c.rootClass} where a preview would say :scope.`,
    `- @media and @supports are fine when everything inside them stays within those selectors. Not possible: @keyframes (so no animation property), @font-face, @import, @property, @layer, :root or element-wide rules.`,
    `- Possible and often enough: colour, background (including gradients), spacing, size, radius, border, shadow, typography, alignment, and hover/focus/active states with transition.`,
    `- This holds for your words too, not only your CSS: do not describe motion that plays by itself (on load, sweeping, repeating), new elements or icons, or changed wording. What the user reads must be what the page can be given.`,
  ];
  if (c.interaction?.kind === 'none') lines.push(`- This region has no open/close interaction registered, so do not specify one.`);
  return lines.join('\n');
}

const ANIM = /(^|[\s;{])animation(-name)?\s*:/i;

// Checks a block of CSS (a proposal's previewCss, or the file content a patch would produce).
// `preview: true` allows :scope, which only exists inside the page preview.
export function checkCss({ css, region, preview = false }) {
  const c = capabilityOf(region);
  const problems = [];
  const { rules, error } = parseRules(css);
  if (error) return [`the CSS could not be parsed: ${error}`];
  for (const r of rules) {
    const context = stripComments(r.context ?? '').trim();
    const at = /@([-\w]+)/.exec(context)?.[1]?.toLowerCase();
    if (at && !AT_RULES_OK.includes(at)) {
      problems.push(`${AT_RULES_NOT_OK[at] ?? `@${at} is not something this region can add`} (${context})`);
      continue;
    }
    const sel = r.selector;
    // An at-rule that holds declarations rather than rules (@font-face, @property) arrives as the rule itself.
    const atSelf = /^@([-\w]+)/.exec(sel.trim())?.[1]?.toLowerCase();
    if (atSelf) {
      problems.push(`${AT_RULES_NOT_OK[atSelf] ?? `@${atSelf} is not something this region can add`} (@${atSelf})`);
      continue;
    }
    const scoped = preview ? sel.replace(/:scope\b/g, c.rootClass) : sel;
    if (!preview && /:scope\b/.test(sel)) {
      problems.push(`"${sel}" uses :scope, which only exists in the preview; in the file write ${c.rootClass}`);
      continue;
    }
    if (!selectorInScope(scoped, { allowed: c.selectors, modifiers: c.modifiers })) {
      problems.push(`"${sel}" is outside this region: only ${c.selectors.join(', ')} can be changed here`);
      continue;
    }
    if (ANIM.test(`;${r.body}`) && !/animation(-name)?\s*:\s*none/i.test(r.body)) {
      problems.push(`"${sel}" uses an animation; this region cannot add the @keyframes it needs (a transition on hover/focus is possible)`);
    }
  }
  // An at-rule that contains nothing parseable still shows up in the text.
  for (const m of css.matchAll(/@([-\w]+)/g)) {
    const at = m[1].toLowerCase();
    if (!AT_RULES_OK.includes(at) && AT_RULES_NOT_OK[at] && !problems.some((p) => p.includes(`@${at}`))) {
      problems.push(`${AT_RULES_NOT_OK[at]} (@${at})`);
    }
  }
  return [...new Set(problems)];
}

// Checks the visual spec's rule list (selector + property/value pairs rather than CSS text).
export function checkSpecRules({ rules, region }) {
  const c = capabilityOf(region);
  const problems = [];
  for (const r of rules ?? []) {
    const sel = String(r.selector ?? '');
    const scoped = sel.replace(/:scope\b/g, c.rootClass);
    if (!selectorInScope(scoped, { allowed: c.selectors, modifiers: c.modifiers })) {
      problems.push(`selector "${sel}" is outside this region: only ${c.selectors.join(', ')} can be changed here`);
      continue;
    }
    const prop = String(r.property ?? '').toLowerCase();
    const value = String(r.value ?? '');
    if ((prop === 'animation' || prop === 'animation-name') && !/^none\b/i.test(value.trim())) {
      problems.push(`"${sel}" specifies ${prop}: this region cannot add the @keyframes an animation needs (a transition is possible)`);
    }
    if (/@keyframes/i.test(value)) problems.push(`"${sel}" describes @keyframes, which this region cannot add`);
  }
  return [...new Set(problems)];
}

// ---- What the words promise ----
//
// Checking CSS is not enough. In W5 the chosen direction's *prose* promised "sweeps in once on load (about 1.4s)"
// and the accepted spec still carried "Reloading the page makes the gradient sweep across once" as a completion
// criterion — so even with every refused rule removed, the user was promised something the region cannot do and
// the reviewer would have judged the page against an impossible criterion.
//
// These patterns stay deliberately narrow: motion that runs by itself (which needs @keyframes) and new markup,
// icons or wording (the source file is read-only). Hover/focus/click transitions are in scope and must pass.
const SELF_RUNNING = [
  [/\b(?:on|at|upon|during)\s+(?:page\s+)?load\b/i, 'runs on page load'],
  [/\bwhen\s+the\s+page\s+(?:loads|opens|first\s+appears)\b/i, 'runs when the page loads'],
  [/\breload(?:s|ing)?\s+the\s+page\b/i, 'depends on reloading the page'],
  [/\bsweep(?:s|ing)?\s+(?:across|in|through|over)\b/i, 'a sweep that plays by itself'],
  [/\banimat(?:e|es|ed|ing|ion|ions)\b/i, 'an animation'],
  [/\bkeyframes?\b/i, 'a @keyframes block'],
  [/\b(?:loops?|loops\s+forever|repeats|pulsing|pulses|blinking|spinning|marquee|autoplay|infinite)\b/i, 'motion that repeats by itself'],
  [/\bfades?\s+in\b/i, 'a fade-in that plays by itself'],
  [/\bslides?\s+(?:in|up|down)\b(?!\s*(?:on|when)\s+hover)/i, 'a slide that plays by itself'],
];
const NEEDS_MARKUP = [
  [/\badd(?:s|ing)?\s+(?:a|an|another|new|two|three)\s+(?:new\s+)?(?:button|icon|image|logo|label|element|section|row|column|link|badge|divider|heading)\b/i, 'a new element'],
  [/\bnew\s+(?:icon|image|svg|button|element|markup|wording|label|heading)\b/i, 'new markup or a new icon'],
  [/\b(?:change|changes|changing|rewrite|rewrites|reword|rewords|rename|renames|shorten|shortens)\s+(?:the\s+)?(?:text|wording|label|copy|title|heading|caption)\b/i, 'changed text'],
];
// "no animation", "without the sweep", "prefers reduced motion" are promises *not* to do it.
const NEGATED = /\b(?:no|not|never|without|avoids?|avoiding|instead\s+of|rather\s+than|prefers?[- ]reduced|reduced[- ]motion)\b[^.;]{0,40}$/i;

export function checkPromises({ texts, region, label = '' }) {
  const problems = [];
  for (const raw of texts) {
    const text = String(raw ?? '');
    for (const [re, what] of [...SELF_RUNNING, ...NEEDS_MARKUP]) {
      const m = re.exec(text);
      if (!m) continue;
      if (NEGATED.test(text.slice(Math.max(0, m.index - 44), m.index))) continue;
      problems.push(`${label}the description promises ${what} ("${text.slice(Math.max(0, m.index - 28), m.index + m[0].length + 28).trim()}"), which this region cannot deliver${SELF_RUNNING.some(([r]) => r === re) ? '; a transition on hover, focus or click is possible' : '; the markup and text are read-only'}`);
      break; // one honest sentence per text is enough to send it back
    }
  }
  return [...new Set(problems)];
}

// A whole direction: what it shows (previewCss) and what it says (name, intent, changes, keepPromise).
export function checkProposal({ proposal, region }) {
  return [
    ...checkCss({ css: proposal.previewCss ?? '', region, preview: true }),
    ...checkPromises({ texts: [proposal.name, proposal.intent, ...(proposal.changes ?? []), proposal.keepPromise], region }),
  ];
}

// Which of the directions on offer cannot be delivered here, and why. Used to keep a later choice honest even
// when the directions were produced before this check existed.
export function blockedProposals({ proposals, region }) {
  const out = {};
  for (const p of proposals ?? []) {
    const problems = checkProposal({ proposal: p, region });
    if (problems.length) out[p.id] = outOfScopeNote(problems);
  }
  return out;
}

// One line for the user when a goal asks for something outside the boundary.
export function outOfScopeNote(problems) {
  return `Some of this cannot be done in this area: ${problems.map((p) => p.replace(/\s*\([^)]*\)\s*$/, '')).join('; ')}.`;
}
