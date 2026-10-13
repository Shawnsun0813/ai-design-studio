// Unified team conversation. Every message is derived from a real session event; the composer only offers the
// actions the session is actually waiting for (or cancel / change direction while the team works).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fileUrl, usd, type Json, type Snapshot, type Role } from './api.ts';
import { OPERATOR, ROLE_NAME, T } from './copy.ts';
import { InterpList, ReviewBody } from './Artifacts.tsx';
import { IconArrow, IconCheck, IconPaperclip, IconTarget, IconUndo, ROLE_ICON } from './icons.tsx';

type Props = {
  snap: Snapshot;
  busy: boolean;
  act: (cmd: Record<string, unknown>) => void;
  preview: string | null;
  onPreview: (proposalId: string | null) => void;
  canPreview: boolean;
  onLocate?: () => void;
};

type Item = { key: string; node: ReactNode };

function TeamMsg({ role, children, cls = '' }: { role: Role; children: ReactNode; cls?: string }) {
  const Icon = ROLE_ICON[role];
  return (
    <div className={`msg team ${cls}`}>
      <div className="speaker"><span className="speaker-icon"><Icon className="icon sm" /></span>{ROLE_NAME[role]}</div>
      <div className="message">{children}</div>
    </div>
  );
}
const Decision = ({ children }: { children: ReactNode }) => <div className="msg you"><span className="dlabel">{T.decision}</span>{children}</div>;

// The files this session may change, by name — never a file name baked into the copy.
const fileList = (st: Json): string => (((st?.region?.allowedFiles ?? []) as string[]).map((f) => f.split('/').pop()).join(' and ')) || 'the allowed file';

function buildChat(p: Props): Item[] {
  const { snap } = p;
  const st = snap.state!;
  const A = (id: string) => snap.artifacts?.[id];
  const items: Item[] = [];
  for (const e of snap.events ?? []) {
    const pl = e.payload || {};
    const k = `e${e.seq}`;
    const push = (node: ReactNode) => items.push({ key: k, node });
    switch (e.type) {
      case 'session_started':
        push(<div className="msg system">{T.sessionStarted(OPERATOR[pl.operator] ?? pl.operator, pl.modelMode === 'stub' ? T.stubModel : T.liveModel(pl.model))}</div>);
        break;
      case 'region_selected':
        push(<div className="msg system">{T.regionPicked(pl.regionId, pl.sourceFile, pl.allowedFiles.join(', '))}</div>);
        break;
      case 'note':
        push(<div className={`msg system ${pl.tone ?? ''}`}>{pl.text}</div>);
        break;
      case 'user_brief': {
        const ref = st.brief?.referenceId ? A(st.brief.referenceId) : null;
        push(<div className="msg you"><span className="dlabel">{T.yourWordsLabel}</span><p>{pl.goal}</p>{ref ? <img className="attach-img" src={fileUrl(snap, ref.data.file)} alt="Reference" style={{ maxWidth: '100%', borderRadius: 4, marginTop: 6 }} /> : null}<span className="small muted">{pl.noReference ? T.noReference : T.referenceNamed(pl.referenceName)}{T.byOperator(pl.by)}</span></div>);
        break;
      }
      case 'round_started':
        push(<div className="msg system round-start">{T.roundStarted(pl.round, pl.base?.label ?? 'the current page')}</div>);
        break;
      case 'artifact_created': {
        const a = A(pl.id);
        if (!a) break;
        const d = a.data;
        if (pl.kind === 'pm-plan') push(<TeamMsg role="pm">{d.mode && d.mode !== 'initial' && <p className="small"><b>{T.pmMode(d.mode)}</b></p>}<p>{d.statusForUser}</p><p className="small muted">{T.pmStatusCriteria(d.goalCriteria.map((c: Json) => c.text).join('; '))}</p></TeamMsg>);
        if (pl.kind === 'interpretation') {
          const it = st.interpretations.find((x) => x.id === pl.id);
          push(<TeamMsg role="ref" cls={`interp ${it?.stale ? 'is-stale' : ''}`}>{it?.stale && <span className="stale-tag">{T.staleInterp}</span>}<p>{d.mode === 'no-reference' ? T.interpIntroNone(it?.version ?? 1) : T.interpIntroRef(it?.version ?? 1)}</p><InterpList d={d} /></TeamMsg>);
        }
        if (pl.kind === 'proposals') push(<Proposals {...p} id={pl.id} />);
        if (pl.kind === 'spec') push(<TeamMsg role="visual"><p>{d.summary}</p>{d.modificationApplied && <p className="small">{T.yourWords(d.modificationApplied)}</p>}<p className="small muted">{T.specRules(d.rules.length, d.criteria.length)}</p></TeamMsg>);
        if (pl.kind === 'handoff') push(<TeamMsg role="pm"><p>{T.handoffFrozen(d.round ?? 1, d.direction.id, !!d.modification, d.criteria.length, `${d.baseVersion.label ?? ''} ${d.baseVersion.short}`, (d.supersedes ?? []).map((x: Json) => x.id).join(', '))}</p></TeamMsg>);
        if (pl.kind === 'patch') push(<TeamMsg role="impl"><p>{d.blocked ? T.cannot(d.blocked) : T.patchSummary(d.edits.length, fileList(st))}</p><p className="small muted">{d.notes}</p></TeamMsg>);
        if (pl.kind === 'review') {
          const hand = Object.values(st.artifacts).filter((x) => x.kind === 'handoff' && x.seq < e.seq).at(-1);
          const r = st.reviews.find((x) => x.id === pl.id);
          const tech = st.techChecks.filter((x) => x.seq < e.seq).at(-1);
          const adoptedHere = st.adoptions.some((x) => x.seq > e.seq);
          push(
            <TeamMsg role="review" cls={`review ${r?.pass ? 'pass' : 'fail'}`}>
              <p>{pl.cycle === 'fix' ? `${T.reviewFix} · ` : ''}{d.summary}</p>
              {d.deviations?.length > 0 && (
                <div className="review-note">
                  <div className="review-note-title"><IconTarget className="icon sm" />{T.findingTitle(d.deviations.length)}</div>
                  {d.deviations.map((x: Json, i: number) => (
                    <div key={i}>
                      <p>{x.what} <span className="muted">{x.element} · {x.property} · {x.width}</span></p>
                      {x.element ? <button type="button" data-show-on-page={i + 1} onClick={() => p.onLocate?.()}>{T.showOnPage}</button> : <span className="no-pin">{T.noPageLocation}</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="review-checks">
                <div><span>{T.rowPageChecks}</span><strong className={tech?.ok ? '' : 'bad'}><IconCheck className="icon xs" />{tech ? (tech.ok ? T.valPassed : T.valProblems) : '—'}</strong></div>
                <div><span>{T.rowDirection}</span><strong className={d.directionMatch === 'pass' ? '' : 'bad'}><IconCheck className="icon xs" />{d.directionMatch === 'pass' ? T.valMatches : d.directionMatch}</strong></div>
                <div><span>{T.rowDecision}</span><strong className="pending">{adoptedHere ? T.valAdopted(st.adopted?.label ?? '') : T.valNotAdopted}</strong></div>
              </div>
              <details><summary className="small muted">{T.reviewInputs}</summary><ReviewBody d={d} criteria={hand ? A(hand.id)?.data.criteria : undefined} /></details>
              <p className="small muted">{T.reviewSummaryNote}</p>
            </TeamMsg>,
          );
        }
        break;
      }
      case 'decision': {
        const by = T.byOperator(pl.by);
        if (pl.kind === 'confirm-interpretation') push(<Decision>{T.decConfirm(st.interpretations.find((x) => x.id === pl.value)?.version)}{by}</Decision>);
        if (pl.kind === 'correct-interpretation') push(<div className="msg you"><span className="dlabel">{T.yourWordsLabel}</span><p>{T.decCorrect(pl.text)}</p><span className="small muted">{by}</span></div>);
        if (pl.kind === 'choose') push(<Decision>{T.decChoose(pl.value, pl.modification)}{by} <span className="mono small">{pl.digest}</span></Decision>);
        if (pl.kind === 'reject') push(<div className="msg you"><span className="dlabel">{T.yourWordsLabel}</span><p>{T.decReject(pl.reason)}</p><span className="small muted">{by}</span></div>);
        if (pl.kind === 'round-decision') {
          if (pl.value === 'feedback') push(<div className="msg you"><span className="dlabel">{T.yourWordsLabel}</span><p>{pl.redirect ? T.redirected(pl.text) : T.decFeedback(pl.text)}</p><span className="small muted">{by}</span></div>);
          else push(<Decision>{pl.value === 'adopt' ? T.decAdopt : pl.value === 'rework' ? T.decRework : pl.value === 'restore' ? T.decRestore(T.restoreTarget[pl.target] ?? pl.target) : T.decFinish}{by}</Decision>);
        }
        if (pl.kind === 'round-end') push(<Decision>{pl.value}{by}</Decision>);
        if (pl.kind === 'retry') push(<Decision>{T.decRetry}{by}</Decision>);
        if (pl.kind === 'choose-again') push(<Decision>{T.decChooseAgain}{by}</Decision>);
        if (pl.kind === 'acknowledge') push(<Decision>{T.decAck}{by}</Decision>);
        break;
      }
      case 'applied':
        push(<div className="msg system">{T.applied(pl.before?.label ?? pl.before?.short, pl.after?.short, fileList(st))}</div>);
        break;
      case 'tech_check':
        push(<div className={`msg system ${pl.ok ? '' : 'warn'}`}>{T.techCheck(pl.items.map((x: Json) => `${x.ok ? '✓' : '✗'} ${x.text}`).join('; '))}</div>);
        break;
      case 'task_failed': {
        const t = e.taskId ? st.tasks[e.taskId] : null;
        push(<div className="msg system error">{T.failedMsg(t ? `${ROLE_NAME[t.role]}: ` : '', pl.reason, pl.code)}</div>);
        break;
      }
      case 'epoch_bumped':
        push(<div className="msg system warn">{pl.reason === 'cancel' ? T.cancelledMsg(st.applies.some((a) => a.seq < e.seq)) : T.redirectMsg}</div>);
        break;
      case 'stale':
        push(<div className="msg system muted">{T.staleMsg(pl.rejectedType, pl.eventEpoch, pl.currentEpoch)}</div>);
        break;
      case 'adopted':
        push(<div className="msg decision adopted"><span className="dlabel">{T.adopted}</span>{T.adoptedMsg(pl.label, String(pl.hash).slice(0, 8), T.byOperator(pl.by))}</div>);
        break;
      case 'restored':
        push(<div className="msg system">{T.restoredMsg(T.restoreTarget[pl.target] ?? pl.target, pl.label, pl.to?.short, fileList(st))}</div>);
        break;
      case 'round_closed':
      case 'session_closed':
        push(<Decision>{T.sessionClosedMsg(pl.outcome)}</Decision>);
        break;
      default:
        break;
    }
  }
  return items;
}

function Proposals(p: Props & { id: string }) {
  const { snap } = p;
  const st = snap.state!;
  const a = snap.artifacts?.[p.id];
  const [mod, setMod] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  if (!a) return null;
  const live = st.waiting?.kind === 'choose' && st.waiting.refs?.proposalsId === p.id;
  const superseded = st.latest.proposals !== p.id;
  const chosen = st.decisions.find((d) => d.kind === 'choose' && d.refs?.proposalsId === p.id);
  const roundCancelled = st.cancels.some((c) => c.round === st.artifacts[p.id]?.round);
  return (
    <TeamMsg role="lead">
      <p>{T.propsIntro(a.data.proposals.length, a.data.recommended, a.data.why)}</p>
      {superseded && <span className="stale-tag">{T.replaced}</span>}
      <div className="props">
        {a.data.proposals.map((x: Json) => (
          <div key={x.id} className={`prop ${chosen && chosen.value !== x.id ? 'is-unchosen' : ''}`} data-proposal={x.id}>
            <div className="prop-head"><b>{x.id} · {x.name}</b>{x.id === a.data.recommended && <span className="rec">{T.recommended}</span>}<span className="kind-proposal">{chosen?.value === x.id ? (roundCancelled ? T.propState.chosenCancelled : T.propState.chosen) : chosen ? T.propState.notChosen : T.propState.open}</span></div>
            <p>{x.intent}</p>
            <ul>{x.changes.map((c: string) => <li key={c}>{c}</li>)}</ul>
            <p className="small muted">{T.refUse}: {x.referenceUse} {T.keepWord}: {x.keepPromise}</p>
            <div className="prop-actions">
              {!superseded && !chosen && (
                <button type="button" className="btn ghost small" disabled={!p.canPreview} title={p.canPreview ? '' : T.previewDisabled} onClick={() => p.onPreview(p.preview === x.id ? null : x.id)}>
                  {p.preview === x.id ? T.exitPreview : T.previewBtn}
                </button>
              )}
              {live && <button type="button" className="btn small" disabled={p.busy} data-choose={x.id} onClick={() => p.act({ type: 'choose', proposalId: x.id, digest: a.digests[x.id], modification: mod })}>{T.chooseBtn(x.id, !!mod.trim())}</button>}
            </div>
          </div>
        ))}
      </div>
      {live && (
        <div className="choice-extra col">
          <label className="small">{T.modLabel}<input className="text" data-modification value={mod} onChange={(e) => setMod(e.target.value)} placeholder={T.modPlaceholder} /></label>
          {!rejecting ? <button type="button" className="btn ghost small" onClick={() => setRejecting(true)}>{T.noneBtn}</button> : (
            <div className="row">
              <input className="text" data-reject-reason value={reason} onChange={(e) => setReason(e.target.value)} placeholder={T.noneReason} />
              <button type="button" className="btn ghost small" data-reject disabled={!reason.trim() || p.busy} onClick={() => p.act({ type: 'reject', reason })}>{T.send}</button>
            </div>
          )}
        </div>
      )}
    </TeamMsg>
  );
}

export default function Conversation(p: Props) {
  const end = useRef<HTMLDivElement>(null);
  const st = p.snap.state!;
  const items = buildChat(p);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [items.length, st.waiting?.seq]);
  const canCancel = (st.busy || p.snap.running || ['failure', 'confirm-interpretation', 'choose'].includes(st.waiting?.kind ?? '')) && !st.cancelled && !st.closed;
  return (
    <section className="convo" aria-label={T.conversation}>
      <div className="convo-head">
        <div>
          <h2>{T.conversation}</h2>
          <p>{st.region ? `${st.region.label ?? st.region.regionId} · ${T.round(st.round)}` : T.round(st.round)}</p>
        </div>
        {canCancel && st.waiting?.kind !== 'failure' && <button type="button" className="text-action danger" data-cancel onClick={() => p.act({ type: 'cancel' })}>{T.cancelRound}</button>}
      </div>
      <ReferenceShelf snap={p.snap} />
      <div className="msgs">
        {items.map((x) => <div key={x.key} className="msg-wrap">{x.node}</div>)}
        {st.busy && <div className="msg system typing">{T.working}</div>}
        <div ref={end} />
      </div>
      <Composer {...p} />
    </section>
  );
}

function ReferenceShelf({ snap }: { snap: Snapshot }) {
  const st = snap.state!;
  const [open, setOpen] = useState(false);
  if (!st.brief) return null;
  const ref = st.brief.referenceId ? snap.artifacts?.[st.brief.referenceId] : null;
  const it = [...st.interpretations].reverse().find((x) => !x.stale) ?? st.interpretations.at(-1);
  const d = it ? snap.artifacts?.[it.id]?.data : null;
  return (
    <div className={`refs ${open ? 'is-open' : ''}`}>
      <button type="button" className="refs-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{ref ? T.refShelf(1) : T.refShelfNone}</span>
        <span className="muted">{it ? T.refReading(it.version, it.confirmed) : T.refNotYet}</span>
        <span className="chev" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="refs-body">
          {ref ? <figure className="ref-thumb"><img src={fileUrl(snap, ref.data.file)} alt="Reference" /><figcaption>{ref.data.name}</figcaption></figure> : <div className="small muted">{T.refUserNone}</div>}
          {d ? (
            <div className="uses">
              <div><b>{d.mode === 'no-reference' ? T.continueRule : T.borrow}</b>{d.borrow.map((x: Json, i: number) => <span key={i} className="use use-borrow">{x.rule}</span>)}</div>
              <div><b>{T.skip}</b>{d.skip.map((x: Json, i: number) => <span key={i} className="use use-skip">{x.aspect}</span>)}</div>
              <div><b>{T.keep}</b>{d.keep.map((x: string, i: number) => <span key={i} className="use use-keep">{x}</span>)}</div>
              {(d.cannotDoHere ?? []).length > 0 && (
                <div data-cannot><b>{T.cannotDoHere}</b>{d.cannotDoHere.map((x: string, i: number) => <span key={i} className="use use-skip">{x}</span>)}</div>
              )}
            </div>
          ) : <p className="muted small">{T.refPending}</p>}
        </div>
      )}
    </div>
  );
}

function RoundDecision({ snap, act, busy }: Props) {
  const st = snap.state!;
  const w = st.waiting!;
  const [text, setText] = useState('');
  const has = (o: string) => w.options.includes(o);
  const targets = w.options.filter((o) => o.startsWith('restore:')).map((o) => o.slice(8));
  const keep: string[] = (snap.artifacts?.[st.latest.handoff ?? '']?.data?.keep ?? []).slice(0, 3);
  return (
    <div className="composer gate round-gate">
      <span className="input-label">{T.gateRound(w.prompt)}</span>
      <div className="btn-row">
        {has('adopt')
          ? <button type="button" className="btn" data-adopt disabled={busy} title={T.adoptHint(w.refs.running)} onClick={() => act({ type: 'round_decision', value: 'adopt' })}><IconCheck className="icon sm" />{T.adoptBtn} · {w.refs.running}</button>
          : st.adopted && <span className="small adopted-note">{T.alreadyAdopted(st.adopted.label)}</span>}
        {has('rework') && <button type="button" className="btn ghost" data-rework disabled={busy} title={T.fixHint} onClick={() => act({ type: 'round_decision', value: 'rework' })}>{T.fixBtn}</button>}
      </div>
      <span className="input-label spaced">{T.refineLabel}</span>
      <div className="input-box">
        <textarea data-feedback value={text} onChange={(e) => setText(e.target.value)} placeholder={T.refinePlaceholder} />
        <div className="input-bottom"><span>{T.nextRoundFrom(w.refs.running ?? '')}</span></div>
      </div>
      {keep.length > 0 && (
        <>
          <span className="input-label faint">{T.carryForward}</span>
          <div className="keep-list">{keep.map((x) => <span key={x}><IconCheck className="icon xs" />{x}</span>)}</div>
        </>
      )}
      <button type="button" className="btn" data-refine disabled={busy || !text.trim()} onClick={() => act({ type: 'round_decision', value: 'feedback', text })}>{T.refineBtn}<IconArrow className="icon sm" /></button>
      <div className="btn-row">
        {targets.map((t) => <button key={t} type="button" className="btn ghost small" data-restore={t} disabled={busy} onClick={() => act({ type: 'round_decision', value: 'restore', target: t })}><IconUndo className="icon xs" />{T.restoreBtn(T.restoreTarget[t] ?? t, w.refs.targets?.[t] ?? '')}</button>)}
        <button type="button" className="btn ghost small" data-finish disabled={busy} onClick={() => act({ type: 'round_decision', value: 'finish' })}>{T.finishBtn}</button>
      </div>
      <p className="safe-note">{T.refineSafeNote}</p>
    </div>
  );
}

function Redirect({ act, busy }: Props) {
  const [text, setText] = useState('');
  return (
    <div className="composer redirect">
      <span className="input-label faint">{T.redirectLabel}</span>
      <div className="input-box"><input data-redirect-text value={text} onChange={(e) => setText(e.target.value)} placeholder={T.redirectPlaceholder} /></div>
      <div className="btn-row"><button type="button" className="btn ghost small" data-redirect disabled={busy || !text.trim()} onClick={() => act({ type: 'redirect', text })}>{T.redirectBtn}</button></div>
    </div>
  );
}

// Pinned action area while the team waits for a direction (baseline screen 2). The per-proposal buttons stay in the
// conversation above; this is the single primary action, carrying whichever direction is selected.
function ChooseGate(p: Props) {
  const { snap, act, busy } = p;
  const st = snap.state!;
  const a = st.waiting?.refs?.proposalsId ? snap.artifacts?.[st.waiting.refs.proposalsId] : null;
  const [sel, setSel] = useState<string>('');
  const [mod, setMod] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  if (!a) return <div className="composer gate"><span className="input-label">{T.gateChoose}</span></div>;
  const list: Json[] = a.data.proposals;
  const chosen = sel || a.data.recommended || list[0]?.id;
  const current = list.find((x) => x.id === chosen);
  return (
    <div className="composer gate">
      <div className="selected-direction">
        <span>{T.selectedDirection}</span>
        <strong>{chosen} · {current?.name}</strong>
      </div>
      <div className="btn-row">
        {list.map((x) => (
          <button key={x.id} type="button" className={`btn ghost small ${x.id === chosen ? 'on' : ''}`} data-select-direction={x.id}
            aria-pressed={x.id === chosen} onClick={() => { setSel(x.id); p.onPreview(x.id); }}>{x.id} · {x.name}</button>
        ))}
      </div>
      <span className="input-label spaced">{T.adjustBefore}</span>
      <div className="input-box"><input data-modification value={mod} onChange={(e) => setMod(e.target.value)} placeholder={T.modPlaceholder} /></div>
      <button type="button" className="btn" data-choose-apply={chosen} disabled={busy || !current}
        onClick={() => act({ type: 'choose', proposalId: chosen, digest: a.digests[chosen], modification: mod })}>
        {T.applyDirection}<IconArrow className="icon sm" />
      </button>
      <p className="safe-note">{T.onlySelectedArea}</p>
      {!rejecting ? (
        <div className="btn-row"><button type="button" className="text-action" onClick={() => setRejecting(true)}>{T.noneBtn}</button></div>
      ) : (
        <>
          <div className="input-box"><input data-reject-reason value={reason} onChange={(e) => setReason(e.target.value)} placeholder={T.noneReason} /></div>
          <div className="btn-row"><button type="button" className="btn ghost small" data-reject disabled={!reason.trim() || busy} onClick={() => act({ type: 'reject', reason })}>{T.send}</button></div>
        </>
      )}
    </div>
  );
}

function Composer(p: Props) {
  const { snap } = p;
  const st = snap.state!;
  const w = st.waiting;
  const [goal, setGoal] = useState('');
  const [ref, setRef] = useState<{ name: string; dataUrl: string } | null>(null);
  const [noRef, setNoRef] = useState(false);
  const [correction, setCorrection] = useState('');
  const readFile = (f: File) => { const r = new FileReader(); r.onload = () => setRef({ name: f.name, dataUrl: String(r.result) }); r.readAsDataURL(f); };

  if (st.status === 'pick-region') return <div className="composer hint">{T.pickHint}</div>;
  if (st.status === 'brief')
    return (
      <div className="composer" onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => /image\/(png|jpeg)/.test(x.type)); if (f) readFile(f); }}>
        {!!st.region?.preserve?.length && (
          <>
            <span className="input-label faint">{T.keepUnchanged}</span>
            <div className="keep-list">{st.region.preserve.slice(0, 3).map((x: string) => <span key={x}><IconCheck className="icon xs" />{x}</span>)}</div>
          </>
        )}
        <span className="input-label spaced">{T.goalLabel}</span>
        <div className="input-box">
          <textarea data-goal value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={T.goalPlaceholder} aria-label={T.goalLabel} />
          <div className="input-bottom">
            <span>{ref ? T.referenceNamed(ref.name) : noRef ? T.noReference : T.addReference}</span>
            <span className="input-tools">
              <label className="check"><input type="checkbox" data-noref checked={noRef} onChange={(e) => { setNoRef(e.target.checked); if (e.target.checked) setRef(null); }} />{T.noRefCheck}</label>
              <label className="attach file" title={T.addReference}>
                <input type="file" accept="image/png,image/jpeg" data-ref-file onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} disabled={noRef} />
                <IconPaperclip className="icon sm" />
              </label>
            </span>
          </div>
        </div>
        <button type="button" className="btn" data-send disabled={p.busy || !goal.trim() || (!ref && !noRef)} onClick={() => p.act({ type: 'brief', goal, reference: ref, noReference: noRef })}>{T.sendToTeam}<IconArrow className="icon sm" /></button>
        <p className="safe-note">{T.briefSafeNote}</p>
      </div>
    );
  if (w?.kind === 'confirm-interpretation')
    return (
      <div className="composer gate">
        <span className="input-label">{T.gateInterp}</span>
        <div className="input-box"><input data-correction value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder={T.correctionPlaceholder} /></div>
        <button type="button" className="btn" data-confirm disabled={p.busy} onClick={() => p.act({ type: 'confirm_interpretation', interpretationId: w.refs.interpretationId })}><IconCheck className="icon sm" />{T.confirmBtn}</button>
        <div className="btn-row"><button type="button" className="btn ghost small" data-correct disabled={!correction.trim() || p.busy} onClick={() => { p.act({ type: 'correct_interpretation', interpretationId: w.refs.interpretationId, text: correction }); setCorrection(''); }}>{T.correctBtn}</button></div>
      </div>
    );
  if (w?.kind === 'choose') return <ChooseGate {...p} />;
  if (w?.kind === 'round-decision') return <RoundDecision {...p} />;
  if (w?.kind === 'failure')
    return (
      <div className="composer gate">
        <span className="input-label">{T.failedGate(st.failure?.code ?? '')}</span>
        <p className="small muted">{st.failure?.reason}</p>
        {st.failure?.note && <p className="small">{st.failure.note}</p>}
        {st.failure?.retryable && <button type="button" className="btn" data-retry disabled={p.busy} onClick={() => p.act({ type: 'retry' })}>{T.retryBtn}</button>}
        {st.failure?.options?.includes('choose_again') && (
          <button type="button" className="btn ghost" data-choose-again disabled={p.busy} title={T.chooseAgainHint} onClick={() => p.act({ type: 'choose_again' })}>{T.chooseAgainBtn}</button>
        )}
        <div className="btn-row">
          {st.failure?.options?.includes('acknowledge')
            ? <button type="button" className="btn ghost small" data-ack onClick={() => p.act({ type: 'acknowledge' })}>{T.ackBtn}</button>
            : <button type="button" className="btn ghost small" data-cancel-fail onClick={() => p.act({ type: 'cancel' })}>{T.endRoundBtn}</button>}
        </div>
      </div>
    );
  if (st.status === 'cancelled') return <div className="composer hint">{T.cancelledHint} <NewSession {...p} /></div>;
  if (st.status === 'closed') return <div className="composer hint">{T.closedHint} <NewSession {...p} /></div>;
  if (st.busy || p.snap.running) {
    const hand = Object.values(st.artifacts).filter((a) => a.kind === 'handoff' && a.round === st.round && a.epoch === st.epoch).at(-1);
    const written = hand && st.applies.some((a) => a.round === st.round && a.seq > hand.seq);
    return (
      <>
        {hand && !written && <Redirect {...p} />}
        <div className="composer hint">{T.workingHint(usd(st.cost.knownUsd))}</div>
      </>
    );
  }
  return <div className="composer hint">{T.waitingServer}</div>;
}

export function NewSession({ snap, act }: Props) {
  const [op, setOp] = useState('developer-test');
  return (
    <span className="new-session">
      <select value={op} onChange={(e) => setOp(e.target.value)} data-operator aria-label="Operator">
        {Object.entries(snap.operators ?? OPERATOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <button type="button" className="btn small" data-new-session onClick={() => act({ type: 'new_session', operator: op })}>{T.newSession}</button>
    </span>
  );
}
