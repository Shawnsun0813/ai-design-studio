// Dev-only selection bridge between the target page and the workbench (parent window).
// Phase02 W3 copy (from the W2 lab copy with the proposal preview channel); W3 adds the `locate` message.
// Phase01's accepted copy is unchanged.
// Contract: registered regions carry data-region-id; nothing here writes files.
declare const __WORKBENCH_ORIGIN__: string;

const parentOrigin = __WORKBENCH_ORIGIN__;
let selecting = false;
let hoverEl: HTMLElement | null = null;
let selectedEl: HTMLElement | null = null;

const style = document.createElement('style');
style.textContent = `
  [data-chain-hover] { outline: 2px dashed #1a5fd0 !important; outline-offset: 2px; cursor: crosshair !important; }
  [data-chain-selected] { outline: 2px solid #1a5fd0 !important; outline-offset: 2px; }
  [data-chain-locate] { outline: 3px solid #2340c4 !important; outline-offset: 3px; animation: chain-locate .7s ease-in-out 3; }
  @keyframes chain-locate { 50% { outline-color: transparent; } }
`;
document.head.appendChild(style);

function post(msg: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage({ source: 'chain-bridge', ...msg }, parentOrigin);
}

function describe(el: Element) {
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length ? `.${[...el.classList].join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

function setHover(el: HTMLElement | null) {
  hoverEl?.removeAttribute('data-chain-hover');
  hoverEl = el;
  hoverEl?.setAttribute('data-chain-hover', '');
}

document.addEventListener('mouseover', (e) => {
  if (!selecting) return;
  const target = e.target as HTMLElement;
  setHover((target.closest('[data-region-id]') as HTMLElement) ?? target);
}, true);

document.addEventListener('click', (e) => {
  if (!selecting) return;
  e.preventDefault();
  e.stopPropagation();
  const target = e.target as HTMLElement;
  const region = target.closest('[data-region-id]') as HTMLElement | null;
  selectedEl?.removeAttribute('data-chain-selected');
  selectedEl = region;
  region?.setAttribute('data-chain-selected', '');
  post({ type: 'selected', regionId: region?.dataset.regionId ?? null, element: describe(region ?? target) });
}, true);

window.addEventListener('message', (e) => {
  if (e.origin !== parentOrigin || e.data?.source !== 'workbench') return;
  if (e.data.type === 'select-mode') {
    selecting = !!e.data.on;
    if (!selecting) setHover(null);
  }
  if (e.data.type === 'clear-selection') {
    selectedEl?.removeAttribute('data-chain-selected');
    selectedEl = null;
  }
  // Phase02 W2③: temporary proposal preview. CSS is injected inside @scope of the region,
  // never written to source; any real source update clears it so a proposal cannot pose as a result.
  if (e.data.type === 'preview-css') showPreview(String(e.data.regionId), String(e.data.proposalId), String(e.data.css));
  if (e.data.type === 'clear-preview') clearPreview('requested');
  // W4/UI-01: read-only geometry query. The workbench asks for the rect of the region or of an element the
  // reviewer named, so it can frame a preview or pin a finding on the real page. Nothing is written here; an
  // unknown selector answers `found: false` so the workbench can say so instead of inventing a position.
  if (e.data.type === 'rect') {
    const token = e.data.token;
    let rect: DOMRect | null = null;
    let found = false;
    try {
      const sel = String(e.data.selector || '');
      const scope = e.data.regionId ? document.querySelector(`[data-region-id="${String(e.data.regionId).replace(/[^\w-]/g, '')}"]`) : document;
      const inside = sel ? (scope as ParentNode | null)?.querySelector(sel) ?? null : null;
      // the reviewer may name the region's own root element, not a child of it
      const el = sel ? inside ?? ((scope as Element | null)?.matches?.(sel) ? (scope as Element) : null) : (scope as Element | null);
      if (el) { rect = el.getBoundingClientRect(); found = true; }
    } catch { found = false; }
    post({ type: 'rect', token, found, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      page: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, scrollY: window.scrollY } });
  }
  // W3: flash a registered region so a task card can point at it on the real page.
  if (e.data.type === 'locate') {
    const el = document.querySelector(`[data-region-id="${String(e.data.regionId).replace(/[^\w-]/g, '')}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      el.setAttribute('data-chain-locate', '');
      setTimeout(() => el.removeAttribute('data-chain-locate'), 2200);
    }
    post({ type: 'located', regionId: e.data.regionId, found: !!el });
  }
});

const PREVIEW_ID = 'chain-proposal-preview';
function showPreview(regionId: string, proposalId: string, css: string) {
  if (!/^[\w-]+$/.test(regionId) || !document.querySelector(`[data-region-id="${regionId}"]`)) {
    post({ type: 'preview-rejected', reason: 'unknown-region', regionId });
    return;
  }
  if (/@import|url\(|<\/style/i.test(css)) {
    post({ type: 'preview-rejected', reason: 'disallowed-css', proposalId });
    return;
  }
  document.getElementById(PREVIEW_ID)?.remove();
  const el = document.createElement('style');
  el.id = PREVIEW_ID;
  el.dataset.proposalId = proposalId;
  el.textContent = `@scope ([data-region-id="${regionId}"]) {
${css}
}`;
  document.head.appendChild(el);
  document.documentElement.dataset.chainPreview = proposalId;
  post({ type: 'preview-applied', proposalId, regionId });
}
function clearPreview(reason: string) {
  const el = document.getElementById(PREVIEW_ID);
  if (!el) return;
  const proposalId = el.dataset.proposalId;
  el.remove();
  delete document.documentElement.dataset.chainPreview;
  post({ type: 'preview-cleared', proposalId, reason });
}

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', (payload) => {
    clearPreview('source-updated');
    post({ type: 'updated', files: payload.updates.map((u) => u.path) });
  });
}

post({ type: 'ready', url: location.href });
