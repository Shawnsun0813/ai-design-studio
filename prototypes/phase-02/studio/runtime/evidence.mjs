// Real-page evidence (W3; extends W2②). Loads the running target page in its own headless tab at a fixed viewport
// and records, for one registered region: the region screenshot, the preserved neighbour screenshot, the region with
// its key interaction expanded, the interaction result, and computed styles of the region's elements.
// W2 gap closed: neighbour and expanded-state screenshots are now part of the reviewer's input.
import { createHash } from 'node:crypto';
import { launch } from '../../lib/cdp.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const PROPS = ['font-size', 'font-weight', 'line-height', 'color', 'background-color', 'margin', 'padding', 'display', 'grid-template-columns', 'gap', 'border', 'border-radius', 'letter-spacing', 'text-transform'];

async function captureAt(b, { url, regionId, neighbour, interaction, width, height = 900 }) {
  await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await b.goto(url);
  await b.until(() => b.evaluate(`!!document.querySelector('[data-region-id="${regionId}"]')`), 'region rendered');
  await new Promise((r) => setTimeout(r, 300));
  const box = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 }; })()`;
  const regionSel = `[data-region-id="${regionId}"]`;
  const regionRect = await b.evaluate(box(regionSel));
  const neighbourRect = neighbour ? await b.evaluate(box(neighbour)) : null;
  const styles = await b.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(regionSel)});
    const out = {};
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const key = el === root ? ':scope' : el.tagName.toLowerCase() + (el.className ? '.' + [...el.classList].join('.') : '');
      if (out[key]) continue;
      const cs = getComputedStyle(el);
      out[key] = Object.fromEntries(${JSON.stringify(PROPS)}.map((p) => [p, cs.getPropertyValue(p)]));
      const r = el.getBoundingClientRect();
      out[key].box = Math.round(r.width) + 'x' + Math.round(r.height);
    }
    return out;
  })()`);
  const regionPng = await b.shot(null, regionRect);
  const neighbourPng = neighbourRect ? await b.shot(null, neighbourRect) : null;
  // The neighbour's own styling (not its pixels): a change above it may move or reflow it on a fluid page, which
  // is not the same as restyling it. The screenshot and its hash stay in the evidence for the reviewer.
  const neighbourStyles = neighbour ? await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(neighbour)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = Object.fromEntries(${JSON.stringify(PROPS)}.map((p) => [p, cs.getPropertyValue(p)]));
    out.text = el.innerText.replace(/\s+/g, ' ').trim().slice(0, 300);
    return out;
  })()`) : null;
  // Key interaction: whichever one the region registers. Default (the sample) is an aria-controls toggle; a
  // <details>/<summary> disclosure is the other supported kind; a region may register none, and then this is
  // reported as "not registered" instead of being quietly passed.
  const kind = interaction?.kind ?? 'aria';
  const sel = interaction?.selector ?? `${regionSel} button[aria-controls]`;
  const open = kind === 'none' ? { skipped: true } : await b.evaluate(`(async () => {
    const t = document.querySelector(${JSON.stringify(sel)});
    if (!t) return { ok: false, reason: 'interaction element not found: ' + ${JSON.stringify(sel)} };
    const kind = ${JSON.stringify(kind)};
    const state = () => (kind === 'details' ? !!t.closest('details')?.open : t.getAttribute('aria-expanded') === 'true');
    const before = state();
    t.click(); await new Promise((r) => setTimeout(r, 180));
    return { before, opened: state() !== before, label: t.textContent.trim().slice(0, 60) };
  })()`);
  const expandedRect = await b.evaluate(box(regionSel));
  const expandedPng = await b.shot(null, expandedRect);
  const close = kind === 'none' ? { skipped: true } : await b.evaluate(`(async () => {
    const t = document.querySelector(${JSON.stringify(sel)});
    if (!t) return { closed: false };
    const kind = ${JSON.stringify(kind)};
    const state = () => (kind === 'details' ? !!t.closest('details')?.open : t.getAttribute('aria-expanded') === 'true');
    const before = state();
    t.click(); await new Promise((r) => setTimeout(r, 180));
    return { closed: state() !== before, label: t.textContent.trim().slice(0, 60) };
  })()`);
  const toggle = kind === 'none'
    ? { ok: null, registered: false, reason: 'no interaction registered for this region' }
    : { ok: !!open.opened && !!close.closed, registered: true, opened: !!open.opened, closed: !!close.closed, labels: [open.label, close.label], reason: open.reason };
  return { width, height, regionRect, neighbourRect, regionPng, neighbourPng, expandedPng, styles, neighbourStyles, toggle, regionSha: sha(regionPng), neighbourSha: neighbourPng ? sha(neighbourPng) : null };
}

// Captures all widths in one short-lived headless Chrome (own profile, own port; only that process is stopped).
export async function captureEvidence({ url, regionId, neighbour, interaction, widths = [1440, 900], cdpPort, label }) {
  const b = await launch({ port: cdpPort, width: widths[0], height: 900 });
  try {
    const shots = {};
    for (const w of widths) shots[w] = await captureAt(b, { url, regionId, neighbour, interaction, width: w });
    return { label, at: new Date().toISOString(), shots };
  } finally {
    b.close();
  }
}

// Saves PNGs as session artifacts and returns a JSON-safe summary with file references.
export function persistEvidence(store, ev, prefix) {
  const shots = {};
  for (const [w, s] of Object.entries(ev.shots)) {
    shots[w] = {
      width: s.width, height: s.height, regionRect: s.regionRect, neighbourRect: s.neighbourRect, toggle: s.toggle, styles: s.styles, neighbourStyles: s.neighbourStyles,
      regionSha: s.regionSha, neighbourSha: s.neighbourSha,
      region: store.saveBinary(`${prefix}-region-${w}.png`, s.regionPng),
      neighbour: s.neighbourPng ? store.saveBinary(`${prefix}-neighbour-${w}.png`, s.neighbourPng) : null,
      expanded: store.saveBinary(`${prefix}-expanded-${w}.png`, s.expandedPng),
    };
  }
  return { label: ev.label, at: ev.at, shots };
}
