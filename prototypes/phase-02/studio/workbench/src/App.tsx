// Workbench shell, aligned to the confirmed baseline (D-024): top bar │ resident team │ real page canvas │
// one team conversation with a pinned action area │ footer. All state still comes from the session server's event
// projection (SSE); user actions are POSTed as commands. Nothing here decides state transitions.
import { useEffect, useRef, useState } from 'react';
import Conversation, { NewSession } from './Conversation.tsx';
import { TaskDrawer, TeamPanel } from './Team.tsx';
import { fileUrl, send, usd, useSnapshot, type Json, type Snapshot } from './api.ts';
import { OPERATOR, T } from './copy.ts';
import { IconCheck, IconColumns, IconCursor, IconDots, IconEye, IconFit, IconInfo, IconLock, IconMonitor, IconTarget } from './icons.tsx';

const TARGET = __TARGET_URL__;
const STEPS = T.stepNames;

function stepOf(snap: Snapshot): number {
  const st = snap.state;
  if (!st || st.status === 'pick-region' || st.status === 'none') return 0;
  if (st.status === 'brief') return 1;
  if (st.closed) return 6;
  if (st.waiting?.kind === 'round-decision') return 6;
  const r = st.round;
  const inR = (k: string) => Object.values(st.artifacts).some((a) => a.kind === k && a.round === r && a.epoch === st.epoch);
  if (inR('review') || inR('evidence-after')) return 5;
  if (inR('spec') || inR('handoff')) return 4;
  if (inR('proposals') || (r > 1 && inR('pm-plan'))) return 3;
  return 2;
}

// Latest screenshot (1440 region) recorded for a version hash, from before/after evidence.
function shotFor(snap: Snapshot, hash?: string): Json {
  if (!hash) return null;
  const evs = Object.values(snap.artifacts ?? {}).filter((a) => (a.kind === 'evidence-after' || a.kind === 'evidence-before') && a.data.version?.hash === hash);
  return evs.at(-1)?.data ?? null;
}

type Rect = { x: number; y: number; width: number; height: number };
type Pin = { n: number; x: number; y: number; element: string; what: string };

export default function App() {
  const { snap, online } = useSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string>();
  const [view, setView] = useState<string>('live'); // 'live' | version hash (screenshot)
  const [preview, setPreview] = useState<string | null>(null); // proposal previewed on the real page
  const [compare, setCompare] = useState(true); // side-by-side proposals in the canvas
  const [siteMode, setSiteMode] = useState(false); // Select area ↔ Preview site
  const [bridge, setBridge] = useState(false);
  const [bridgeN, setBridgeN] = useState(0); // bumped on every 'ready' from the real page, so a reload re-applies the preview
  const [now, setNow] = useState(Date.now());
  const [frames, setFrames] = useState<Record<string, { k: number; x: number; y: number; h: number }>>({});
  const [pins, setPins] = useState<Pin[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  const previewFrames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const snapRef = useRef<Snapshot | null>(null);
  snapRef.current = snap;

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const act = async (cmd: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const r = await send(snapRef.current, cmd);
      if (!r.ok) setError(r.message || r.code || 'The action was refused');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const postTo = (win: Window | null | undefined, msg: Record<string, unknown>) => win?.postMessage({ source: 'workbench', ...msg }, TARGET);
  const post = (msg: Record<string, unknown>) => postTo(frame.current?.contentWindow, msg);
  const st = snap?.state;
  const selectable = !!st && (st.status === 'pick-region' || st.status === 'brief');
  const selecting = selectable && !siteMode;

  // proposals of the current round/epoch, and whether the page is still the version they were made for
  const propsA = st ? Object.values(st.artifacts).filter((a) => a.kind === 'proposals' && a.round === st.round && a.epoch === st.epoch).at(-1) : null;
  const props = propsA ? snap?.artifacts?.[propsA.id] : null;
  const chosen = !!props && !!st?.decisions.some((d) => d.kind === 'choose' && d.refs?.proposalsId === props.id);
  const canPreview = !!props && !chosen && snap?.pageVersion?.hash === props.baseVersion?.hash && !st?.cancelled && !st?.closed;
  const choosing = !!st && st.waiting?.kind === 'choose' && canPreview;
  const showCompare = choosing && compare && !preview;

  // bridge → workbench (the real page and every proposal preview talk through the same channel)
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== TARGET || e.data?.source !== 'chain-bridge') return;
      // dev aid: the last bridge messages, so a check can see what the page actually reported
      (window as unknown as { __bridge?: unknown[] }).__bridge = [...(((window as unknown as { __bridge?: unknown[] }).__bridge ?? []).slice(-19)), { t: e.data.type, url: e.data.url, token: e.data.token, found: e.data.found }];
      const d = e.data;
      const which = (() => { try { return new URL(String(d.url ?? '')).searchParams.get('p'); } catch { return null; } })();
      if (d.type === 'ready') {
        if (which) {
          const f = previewFrames.current[which];
          const p = snapRef.current?.artifacts?.[propsA?.id ?? '']?.data?.proposals?.find((x: Json) => x.id === which);
          const regionId = snapRef.current?.state?.region?.regionId;
          if (f && p && regionId) {
            postTo(f.contentWindow, { type: 'preview-css', regionId, proposalId: which, css: p.previewCss });
            postTo(f.contentWindow, { type: 'rect', token: `prop:${which}`, regionId });
          }
        } else { setBridge(true); setBridgeN((n) => n + 1); }
      }
      if (d.type === 'selected') act({ type: 'select_region', regionId: d.regionId, element: d.element });
      if (d.type === 'preview-cleared' && d.reason === 'source-updated' && !which) setPreview(null);
      if (d.type === 'rect') {
        const token = String(d.token ?? '');
        if (token.startsWith('prop:') && d.found && d.rect) {
          const r = d.rect as Rect;
          const box = previewFrames.current[token.slice(5)]?.parentElement?.getBoundingClientRect();
          const k = box && r.width ? Math.min(1, (box.width - 2) / r.width) : 1;
          setFrames((f) => ({ ...f, [token.slice(5)]: { k, x: r.x, y: r.y, h: Math.round(r.height * k) + 2 } }));
        }
        if (token.startsWith('pin:')) {
          const [, n, element] = token.split(':');
          if (d.found && d.rect) {
            const r = d.rect as Rect;
            setPins((old) => [...old.filter((p) => p.n !== Number(n)), { n: Number(n), x: r.x + r.width - 6, y: r.y + r.height / 2, element, what: '' }].sort((a, b) => a.n - b.n));
          }
        }
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [propsA?.id]);

  useEffect(() => { if (bridge) post({ type: 'select-mode', on: selecting }); }, [bridge, selecting]);
  useEffect(() => { if (!selectable) setSiteMode(false); }, [selectable]);
  // When the page comes back after a disconnect, reload the frame so the bridge reconnects.
  const reachable = !!snap?.connection?.reachable;
  const wasReachable = useRef(reachable);
  useEffect(() => {
    if (reachable && !wasReachable.current && frame.current) { setBridge(false); frame.current.src = `${TARGET}/?r=${Date.now()}`; }
    if (!reachable) setBridge(false);
    wasReachable.current = reachable;
  }, [reachable]);

  // single-proposal preview on the real page (unchanged W3/W4 behaviour: temporary styles, never written)
  useEffect(() => {
    if (!bridge) return;
    if (preview && props && canPreview) {
      const x = props.data.proposals.find((q: { id: string }) => q.id === preview);
      if (x) { post({ type: 'preview-css', regionId: st!.region!.regionId, proposalId: x.id, css: x.previewCss }); setView('live'); return; }
    }
    post({ type: 'clear-preview' });
  }, [preview, canPreview, bridge, bridgeN, props?.id]);
  useEffect(() => { if (!canPreview && preview) setPreview(null); }, [canPreview]);
  useEffect(() => { if (!choosing) setCompare(true); }, [choosing]);

  // review findings: ask the real page for the rect of each element the reviewer named. No rect → no pin.
  const review = st?.review && st.latest.review ? snap?.artifacts?.[st.latest.review] : null;
  const deviations: Json[] = review?.data?.deviations ?? [];
  const reviewId = review?.id;
  useEffect(() => {
    setPins([]);
    if (!bridge || !reviewId || !st?.region || view !== 'live' || preview || showCompare) return;
    deviations.forEach((d: Json, i: number) => {
      if (d.element) post({ type: 'rect', token: `pin:${i + 1}:${d.element}`, regionId: st.region!.regionId, selector: d.element });
    });
  }, [reviewId, bridge, view, preview, showCompare]);

  const step = snap ? stepOf(snap) : 0;
  const pv = snap?.pageVersion;
  const running = st?.running;
  const curLabel = !st || !running ? 'current' : running.hash === pv?.hash ? running.label : 'changed outside the studio';
  const distinct: Json[] = [];
  for (const v of st?.versions ?? []) if (!distinct.some((x) => x.hash === v.hash)) distinct.push(v);
  const earlier = snap ? distinct.filter((v) => v.hash !== running?.hash && shotFor(snap, v.hash)) : [];
  const viewed = view !== 'live' ? distinct.find((v) => v.hash === view) : null;
  const viewedShot = viewed && snap ? shotFor(snap, viewed.hash) : null;
  const led = snap?.ledger;
  const stub = snap?.modelMode === 'stub';
  const adoptedIsRunning = !!(st?.adopted && running && st.adopted.hash === running.hash);
  const runningTask = st ? st.order.map((id) => st.tasks[id]).filter((t) => t.status === 'running').at(-1) : undefined;
  const ctx = !st ? T.ctxPick
    : st.closed ? T.ctxClosed
    : showCompare ? T.ctxChoose
    : st.status === 'pick-region' ? T.ctxPick
    : st.waiting?.kind === 'round-decision' ? T.ctxReview
    : runningTask ? T.ctxWorking(runningTask.action ?? runningTask.title)
    : st.region ? T.ctxBrief(st.region.label ?? st.region.regionId)
    : T.ctxPick;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brandmark" aria-hidden="true"><i /><i /><i /><i /></span>
          <b>{T.brand}</b>
        </div>
        <span className="divider" aria-hidden="true" />
        <div className="project">
          <IconMonitor className="icon sm" />
          <span>{snap?.registry?.project ?? '—'}</span>
          <span className="crumb">/ {snap?.registry?.page ?? ''}</span>
        </div>
        <div className="top-right">
          <span className={`conn ${reachable ? '' : 'off'}`} data-target-conn={reachable ? 'up' : 'down'}><i aria-hidden="true" />{reachable ? T.connected : T.notConnected}</span>
          {st?.session && <span className="tag op">{OPERATOR[st.session.operator] ?? st.session.operator}</span>}
          {stub && <span className="tag stub">{T.footerStub}</span>}
          {snap?.code && <span className="tag" data-code-version={snap.code.short} title={T.codeHint(snap.code.startedAt)}>{T.codeVersion(snap.code.short)}</span>}
          {st && <span className="cost" title={T.costHint}>{T.sessionCost(usd(st.cost.knownUsd), st.cost.unknownCalls)}</span>}
          {led && !stub && <span className="cost">{T.budget(usd(led.tranche.countedUsd), snap?.caps?.tranche ?? 5)}</span>}
          <span className="icon-btn bordered" aria-hidden="true"><IconDots className="icon sm" /></span>
        </div>
      </header>
      {!online && <div className="banner-top error" role="alert" data-studio-down>{T.studioDown}</div>}
      {online && snap && !reachable && <div className="banner-top warn" role="alert" data-page-down>{T.pageDown(TARGET)}</div>}

      <div className="main">
        {st ? <TeamPanel snap={snap!} openId={openId} onOpen={setOpenId} now={now} /> : (
          <section className="team" aria-label={T.teamTitle}>
            <div className="team-top"><h2>{T.teamTitle}</h2><span className="count">{T.rolesCount(6)}</span></div>
            <p className="team-caption">{T.teamCaption}</p>
            <p className="small muted">{T.noSession}</p>
          </section>
        )}

        <section className="stage" aria-label={T.pageRegion}>
          <div className="context-bar">
            <div className="context-copy">
              <h1>{ctx.title}</h1>
              <p>{ctx.sub}</p>
            </div>
            <div className="step-context">
              <span className="step-dots" aria-hidden="true">{STEPS.map((s2, i) => <i key={s2} className={i < step ? 'done' : i === step ? 'current' : ''} />)}</span>
              <span>{STEPS[step]}</span>
            </div>
          </div>

          <div className="canvas-toolbar">
            <div className="seg" role="group" aria-label="Canvas mode">
              {choosing ? (
                <>
                  <button type="button" aria-pressed={showCompare} data-mode="compare" onClick={() => { setCompare(true); setPreview(null); }}><IconColumns className="icon sm" />{T.sideBySide}</button>
                  <button type="button" aria-pressed={!showCompare} data-mode="live" onClick={() => setCompare(false)}><IconEye className="icon sm" />{T.livePage}</button>
                </>
              ) : (
                <>
                  <button type="button" aria-pressed={selecting} disabled={!selectable} data-mode="select" onClick={() => setSiteMode(false)}><IconCursor className="icon sm" />{T.selectArea}</button>
                  <button type="button" aria-pressed={!selecting} disabled={!selectable} data-mode="site" onClick={() => setSiteMode(true)}><IconEye className="icon sm" />{T.previewSite}</button>
                </>
              )}
            </div>
            <div className="canvas-actions">
              <button type="button" className={`ver ver-${adoptedIsRunning ? 'adopted' : running && running.kind !== 'original' ? 'result' : 'original'}`} aria-pressed={view === 'live' && !preview && !showCompare} onClick={() => { setView('live'); setPreview(null); setCompare(false); }} data-ver="live">
                <span className="ver-kind">{T.running}</span>{curLabel}{pv ? <> · <span className="mono">{pv.short}</span></> : null}{adoptedIsRunning ? <span className="ver-badge"> · {T.adopted}</span> : null}
              </button>
              {st?.adopted && !adoptedIsRunning && (
                <button type="button" className="ver" aria-pressed={view === st.adopted.hash} onClick={() => { setPreview(null); setView(st.adopted.hash); }} data-ver="adopted"><span className="ver-kind">{T.adopted}</span>{st.adopted.label}</button>
              )}
              {earlier.filter((v) => v.hash !== st?.adopted?.hash).map((v) => (
                <button key={v.hash} type="button" className="ver" aria-pressed={view === v.hash} onClick={() => { setPreview(null); setView(v.hash); }} data-ver={`hist-${v.label}`}><span className="ver-kind">{T.history}</span>{v.label}</button>
              ))}
              {props && canPreview && props.data.proposals.map((x: { id: string }) => (
                <button key={x.id} type="button" className="ver" aria-pressed={preview === x.id} onClick={() => { setPreview(preview === x.id ? null : x.id); setCompare(false); }} data-ver={`prop-${x.id}`}><span className="ver-kind">{T.proposal}</span>{x.id}</button>
              ))}
              <span className="muted"><IconMonitor className="icon sm" /> {T.viewportDesktop}</span>
              <span className="muted"><IconFit className="icon sm" /> {T.fit}</span>
            </div>
          </div>

          <div className="frame">
            {showCompare && props ? (
              <div className="compare">
                <div className="compare-intro">
                  <div>
                    <h2>{T.compareHeading(props.data.proposals.length)}</h2>
                    <p>{T.compareSub}</p>
                  </div>
                  <span>{st?.region?.label ?? st?.region?.regionId}</span>
                </div>
                <div className="directions">
                  {props.data.proposals.map((x: Json) => {
                    const f = frames[x.id];
                    return (
                      <article key={x.id} className={`direction-card ${preview === x.id ? 'chosen' : ''}`} data-direction={x.id}>
                        <header className="direction-header">
                          <span className="direction-name"><span className="direction-letter">{x.id}</span><span>{x.name}</span></span>
                          {x.id === props.data.recommended && <span className="recommended">{T.recommended}</span>}
                        </header>
                        <div className="region-preview">
                          <div className="region-window" style={f ? { height: f.h } : undefined}>
                            <iframe
                              ref={(el) => { previewFrames.current[x.id] = el; }}
                              title={`Proposal ${x.id} preview`}
                              src={`${TARGET}/?p=${x.id}`}
                              style={{ width: 732, height: 1100, transform: f ? `scale(${f.k}) translate(${-f.x}px, ${-f.y}px)` : 'scale(1)' }}
                            />
                          </div>
                        </div>
                        <div className="direction-caption">
                          <strong>{x.intent}</strong>
                          <ul>{(x.changes ?? []).slice(0, 3).map((c: string) => <li key={c}>{c}</li>)}</ul>
                        </div>
                        <div className="direction-footer">
                          <span className="proposal-label"><IconLock className="icon xs" />{T.previewLabel}</span>
                          <button type="button" data-choose-canvas={x.id} onClick={() => { setCompare(false); setPreview(x.id); }}>{T.previewBtn}</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="compare-preserve">
                  <IconCheck className="icon sm" />
                  <span>{T.bothPreserve(st?.region?.preserve?.slice(0, 2).join(', ') ?? 'your content')}</span>
                </div>
              </div>
            ) : null}
            <div className={`page-shell ${preview ? 'frame-proposal' : viewed ? 'frame-original' : adoptedIsRunning ? 'frame-adopted' : ''}`} style={showCompare ? { display: 'none' } : undefined}>
                <div className="frame-bar">
                  <span className={`frame-kind ${preview ? 'fk-proposal' : adoptedIsRunning && !viewed ? 'fk-adopted' : ''}`}>{preview ? T.preview(preview) : viewed ? T.screenshotOf(viewed.label) : `${T.running} ${curLabel}`}</span>
                  <span>{preview ? T.previewNote : viewed ? T.screenshotNote : selecting ? T.pickNote : T.runningNote}</span>
                  <span className="muted">{bridge ? T.bridgeReady : T.bridgeWaiting}</span>
                </div>
                <div className="frame-body">
                  <iframe ref={frame} id="target-frame" src={`${TARGET}/`} title="Target website" style={{ display: viewed ? 'none' : 'block' }} />
                  {!viewed && pins.length > 0 && (
                    <div className="pin-layer">
                      {pins.map((p) => (
                        <button key={p.n} type="button" className="pin" style={{ left: p.x, top: p.y }} title={p.element} data-pin={p.n}
                          onClick={() => post({ type: 'locate', regionId: st?.region?.regionId })}>{p.n}</button>
                      ))}
                    </div>
                  )}
                {viewed && viewedShot && <div className="before-view"><img src={fileUrl(snap, viewedShot.shots['1440'].region)} alt={`${viewed.label} region screenshot`} /><p className="small muted">{viewed.label} · {viewed.hash.slice(0, 8)} · 1440 px</p></div>}
              </div>
            </div>
          </div>
          <p className="canvas-note">
            <IconInfo className="icon sm" />
            {showCompare ? T.proposalNotWritten : selecting ? T.pickNote : st?.region ? T.onlyRegionChanges(st.region.label ?? st.region.regionId) : T.runningNote}
          </p>
        </section>

        {st ? (
          <div className="convo-wrap">
            {error && <div className="cmd-error" role="alert" onClick={() => setError(null)} data-cmd-error>{error}</div>}
            <Conversation key={snap!.sessionId} snap={snap!} busy={busy} act={act} preview={preview} onPreview={(id) => { setPreview(id); setCompare(false); }} canPreview={canPreview} onLocate={() => post({ type: 'locate', regionId: st.region?.regionId })} />
          </div>
        ) : (
          <section className="convo">
            <div className="convo-head"><div><h2>{T.conversation}</h2><p>{T.noSession}</p></div></div>
            <div className="start">
              <p>{T.startIntro}</p>
              <p className="small muted">{T.startNote}</p>
              {snap ? <NewSession snap={snap} busy={busy} act={act} preview={null} onPreview={() => {}} canPreview={false} /> : <p className="muted">{T.connecting}</p>}
              {error && <p className="bad small">{error}</p>}
            </div>
          </section>
        )}

        {openId && st?.tasks[openId] && (
          <TaskDrawer snap={snap!} task={st.tasks[openId]} onClose={() => setOpenId(undefined)} onLocate={() => post({ type: 'locate', regionId: st.tasks[openId].region })} />
        )}
      </div>

      <footer className="footer">
        <span>{stub ? T.footerStub : T.footerLive(st?.session?.model ?? 'claude-sonnet-5-5')}{snap?.events ? ` · ${T.footerEvents(snap.events.length)}` : ''}</span>
        <span className="footer-steps">
          {st && <span><IconTarget className="icon xs" /> {T.round(st.round)}</span>}
          <span className="current">{STEPS[step]}</span>
        </span>
      </footer>
    </div>
  );
}
