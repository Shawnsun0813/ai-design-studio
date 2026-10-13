// The resident team (P02-V01–V05, baseline D-024): six responsibilities are always listed, each showing its real
// task, status, round and artifacts from the event projection. A role with no task this round says so; a role whose
// result is carried over from an earlier round says that too — it is never shown as if it ran again.
// "Tasks" and "Activity" keep the full per-task view; no percentages, no invented parallelism.
import { useEffect, useRef, useState } from 'react';
import { hhmmss, usd, type Ev, type Role, type Snapshot, type Task } from './api.ts';
import { HANDOFF_TO, KIND_OF_WORK, OPERATOR, ROLE_NAME, STATUS_NAME, STATUS_SHORT, T } from './copy.ts';
import { ArtifactView } from './Artifacts.tsx';
import { IconClock, IconClose, IconDoc, IconLock, ROLE_ICON } from './icons.tsx';

const ROLES: Role[] = ['pm', 'ref', 'lead', 'visual', 'impl', 'review'];
const WILL: Record<Role, string> = {
  pm: 'Plans the round and the completion conditions', ref: 'Reads your reference', lead: 'Proposes directions',
  visual: 'Defines the details', impl: 'Applies your choice', review: 'Checks the actual result', exec: 'Writes the change',
};
const kindOf = (t: Task) => (t.kind === 'program' ? (t.role === 'pm' ? KIND_OF_WORK.programPm : KIND_OF_WORK.program) : t.role === 'impl' ? KIND_OF_WORK.modelPatch : KIND_OF_WORK.model);
const secs = (from?: string, to?: string, now?: number) => (from ? Math.max(0, Math.round(((to ? Date.parse(to) : now ?? Date.now()) - Date.parse(from)) / 1000)) : 0);

export function StatusMark({ status, short }: { status: Task['status']; short?: boolean }) {
  return <span className={`st st-${status}`}><i aria-hidden="true" />{(short ? STATUS_SHORT : STATUS_NAME)[status]}</span>;
}

// One row per responsibility: its latest task in the current round, or the inherited one, or "not started".
function RoleRow({ snap, role, openId, onOpen, now }: { snap: Snapshot; role: Role; openId?: string; onOpen: (id: string) => void; now: number }) {
  const st = snap.state!;
  const tasks = st.order.map((id) => st.tasks[id]).filter((t) => t.role === role);
  const here = tasks.filter((t) => t.round === st.round);
  const task = (here.length ? here : tasks).at(-1);
  const inherited = !!task && task.round !== st.round;
  const Icon = ROLE_ICON[role];
  const waits = task?.status === 'waiting_user' || task?.status === 'returned';
  const active = !!task && task.id === openId;
  const body = (
    <div className="card-body">
      <div className="card-top">
        <span className="role">{ROLE_NAME[role]}</span>
        {task && !inherited ? <StatusMark status={task.status} short /> : <span className="st"><i aria-hidden="true" />{inherited ? T.inheritedFrom(task!.round) : T.notStarted}</span>}
      </div>
      <div className="card-title" title={task ? (inherited ? task.title : task.action ?? task.title) : WILL[role]}>{task ? (inherited ? task.title : task.action ?? task.title) : WILL[role]}</div>
      {task && task.status === 'running' && <div className="card-action">{T.seconds(secs(task.startedAt, undefined, now))}</div>}
      {task && task.artifacts.length > 0 && (
        <span className="artifact-link"><IconDoc className="icon xs" />{snap.artifacts?.[task.artifacts[0]]?.title ?? T.artifacts(task.artifacts.length)}</span>
      )}
    </div>
  );
  if (!task) return <div className="card" data-role={role} data-status="none">{<span className="role-icon"><Icon className="icon" /></span>}{body}</div>;
  return (
    <button type="button" className={`card c-${task.status} ${active ? 'is-active' : ''} ${waits ? 'waits' : ''}`} onClick={() => onOpen(task.id)}
      data-task={task.id} data-role={role} data-status={task.status} data-round={task.round}>
      <span className="role-icon"><Icon className="icon" /></span>
      {body}
    </button>
  );
}

export function TaskCard({ task, active, onOpen, now }: { task: Task; active?: boolean; onOpen?: () => void; now: number }) {
  const Icon = ROLE_ICON[task.role];
  return (
    <button type="button" className={`card c-${task.status} ${active ? 'is-active' : ''}`} onClick={onOpen} data-task={task.id} data-role={task.role} data-status={task.status} data-round={task.round}>
      <span className="role-icon"><Icon className="icon" /></span>
      <div className="card-body">
        <div className="card-top">
          <span className="role">{ROLE_NAME[task.role]}{task.kind === 'program' ? ' · program' : ''}</span>
          <StatusMark status={task.status} />
        </div>
        <div className="card-title">{task.title}</div>
        {task.action && <div className="card-action">{task.action}{task.status === 'running' ? ` · ${T.seconds(secs(task.startedAt, undefined, now))}` : ''}</div>}
        {task.returnReason && task.status === 'returned' && (
          <ul className="card-reason">{task.returnReason.slice(0, 2).map((r) => <li key={r}>{r}</li>)}</ul>
        )}
        <div className="card-meta">
          <span>{T.round(task.round)}</span>
          <span>{T.basedOn(task.version)}</span>
          {task.instances.length > 1 && <span>{T.attempts(task.instances.length)}</span>}
          {task.artifacts.length > 0 && <span className="art-count">{T.artifacts(task.artifacts.length)}</span>}
          {task.handoffTo && task.status === 'done' && <span>→ {HANDOFF_TO[task.handoffTo] ?? task.handoffTo}</span>}
        </div>
      </div>
    </button>
  );
}

// One plain-English line per event for the activity list (technical codes stay at the end, in brackets).
export function eventText(e: Ev, tasks: Record<string, Task>): string | null {
  const t = e.taskId ? tasks[e.taskId] : undefined;
  const who = t ? ROLE_NAME[t.role] : '';
  const p = e.payload || {};
  switch (e.type) {
    case 'session_started': return `Session started · ${OPERATOR[p.operator] ?? p.operator}${p.modelMode === 'stub' ? ' · stub model' : ''}`;
    case 'region_selected': return `Region ${p.regionId} selected`;
    case 'user_brief': return `You sent your goal${p.noReference ? ' (no reference)' : ' and a reference'}`;
    case 'round_started': return `Round ${p.round} started from ${p.base?.label ?? 'the current page'}${p.redirect ? ' (change of direction)' : ''}`;
    case 'task_created': return `${who}: task "${p.title}"`;
    case 'instance_started': return `${who}: started${p.attempt > 1 ? ` attempt ${p.attempt}` : ''} (${p.model === 'program' ? 'program' : `${p.model} · ${p.promptVersion}`})`;
    case 'instance_ended': return p.status === 'ok' ? null : `${who}: run ended · ${p.code || p.status}${p.usdUnknown ? ' · cost unknown' : ''}`;
    case 'progress': return `${who}: ${p.text}`;
    case 'artifact_created': return `${who}: artifact "${p.title || p.kind}"`;
    case 'instance_finished': return `${who}: done${p.handoffTo ? ` → ${HANDOFF_TO[p.handoffTo] ?? p.handoffTo}` : ''}`;
    case 'waiting_user': return p.kind === 'failure' ? `Waiting for you after a failure: ${p.prompt}` : `Waiting for you: ${p.prompt}`;
    case 'decision': return `Decision: ${p.kind}${p.value ? ` = ${String(p.value).slice(0, 24)}` : ''}${p.target ? ` (${p.target})` : ''}${T.byOperator(p.by)}`;
    case 'task_failed': return `${who} failed: ${p.reason} (${p.code})`;
    case 'applied': return `Written: ${p.before?.label ?? p.before?.short} → ${p.after?.short}`;
    case 'version_observed': return `Version ${p.label} (${p.kind}) = ${String(p.hash).slice(0, 8)}`;
    case 'tech_check': return `Technical checks ${p.items.filter((x: { ok: boolean }) => x.ok).length}/${p.items.length}`;
    case 'review_passed': return 'Review passed (not an adoption)';
    case 'review_returned': return `Review found issues: ${(p.reasons || [])[0] ?? ''}`;
    case 'adopted': return `Adopted ${p.label}${T.byOperator(p.by)}`;
    case 'restored': return `Restored the ${p.target} version (${p.label})`;
    case 'restore_failed': return `Restore refused: ${p.reason} (${p.code})`;
    case 'epoch_bumped': return `${p.note} (generation ${p.from}→${p.to})`;
    case 'stale': return `Late result refused (${p.rejectedType}, generation ${p.eventEpoch}≠${p.currentEpoch})`;
    case 'round_closed':
    case 'session_closed': return `Session finished: ${p.outcome}`;
    case 'note': return p.text;
    default: return null;
  }
}

export function TeamPanel({ snap, openId, onOpen, now }: { snap: Snapshot; openId?: string; onOpen: (id: string) => void; now: number }) {
  const [mode, setMode] = useState<'team' | 'tasks' | 'timeline'>('team');
  // The six responsibilities come first: when the panel is short (small window, or a connection banner above it),
  // the extras below them give up their space instead of pushing a role out of sight. The thresholds are measured
  // against the panel itself, so they do not flip back and forth when the extras disappear.
  const panel = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(1000);
  useEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setRoom(el.clientHeight));
    ro.observe(el);
    setRoom(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const showRecent = room >= 940;
  const showScope = room >= 820;
  const st = snap.state!;
  const tasks = st.order.map((id) => st.tasks[id]);
  const running = tasks.filter((t) => t.status === 'running').at(-1);
  const w = st.waiting;
  const rounds = [...new Set(tasks.map((t) => t.round))].sort((a, b) => b - a);
  const events = (snap.events ?? []).map((e) => ({ e, text: eventText(e, st.tasks) })).filter((x) => x.text);
  const roundState = st.closed ? T.sessionClosed : st.cancelled ? T.sessionCancelled
    : w ? (w.kind === 'failure' ? T.failedWaiting : T.waitingForYou)
    : running ? T.roundWorking : tasks.length ? T.roundDone : T.readyToBegin;
  return (
    <section className="team" aria-label={T.teamTitle} ref={panel}>
      <div className="team-top">
        <h2>{T.teamTitle}</h2>
        <span className="count">{T.rolesCount(ROLES.length)}</span>
      </div>
      <p className="team-caption">{T.teamCaption}</p>
      <div className="team-round">
        <strong>{T.round(st.round)}</strong>
        <span data-now>{roundState}</span>
      </div>
      <div className="seg" role="tablist" style={{ margin: '0 5px 9px' }}>
        <button type="button" role="tab" aria-pressed={mode === 'team'} onClick={() => setMode('team')}>{T.viewTeam}</button>
        <button type="button" role="tab" aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>{T.viewTasks}</button>
        <button type="button" role="tab" aria-pressed={mode === 'timeline'} onClick={() => setMode('timeline')}>{T.viewTimeline}</button>
      </div>

      {mode === 'team' && (
        <>
          <div className="roles">
            {ROLES.map((r) => <RoleRow key={r} snap={snap} role={r} openId={openId} onOpen={onOpen} now={now} />)}
          </div>
          {showRecent && (
          <button type="button" className="team-recent" onClick={() => setMode('timeline')} title={T.recentActivity}>
            <h3>{T.recentActivity}<IconClock className="icon xs" /></h3>
            <div className="activity">{events.at(-1)?.text ?? T.noEvents}</div>
          </button>
          )}
          {showScope && (
          <div className="team-bottom">
            <p>{T.workingOn}</p>
            <div className="scope">
              <IconLock className="icon sm" />
              <span><b>{st.region?.label ?? st.region?.regionId ?? '—'}</b>{T.scopeIntact}</span>
            </div>
          </div>
          )}
        </>
      )}

      {mode === 'tasks' && (
        <div className="cards">
          {rounds.map((r) => (
            <div key={r} className="round-group">
              <div className="round-label">{T.round(r)}{r === st.round ? T.current : ''}</div>
              {tasks.filter((t) => t.round === r).slice().reverse().map((t) => (
                <TaskCard key={t.id} task={t} active={t.id === openId} onOpen={() => onOpen(t.id)} now={now} />
              ))}
            </div>
          ))}
          <p className="foot-note">{T.footNote(snap.events?.length ?? 0)}</p>
        </div>
      )}

      {mode === 'timeline' && (
        <ol className="timeline">
          {events.slice().reverse().map(({ e, text }) => (
            <li key={e.seq} className={`tl tl-${e.type}`} onClick={() => e.taskId && st.tasks[e.taskId] && onOpen(e.taskId)}>
              <time>{hhmmss(e.ts)}</time>
              <span>{text}</span>
            </li>
          ))}
          {events.length === 0 && <li className="muted">{T.noEvents}</li>}
        </ol>
      )}
    </section>
  );
}

export function TaskDrawer({ snap, task, onClose, onLocate }: { snap: Snapshot; task: Task; onClose: () => void; onLocate: () => void }) {
  const [tab, setTab] = useState<'art' | 'brief' | 'ev'>('art');
  const st = snap.state!;
  const evs = (snap.events ?? []).filter((e) => e.taskId === task.id);
  const handoffId = Object.values(st.artifacts).filter((a) => a.kind === 'handoff' && a.round === task.round && a.seq < (st.artifacts[task.artifacts[0]]?.seq ?? Infinity)).at(-1)?.id;
  const handoff = handoffId && ['impl', 'review'].includes(task.role) ? snap.artifacts?.[handoffId] : null;
  return (
    <aside className="drawer" aria-label="Task details" data-drawer={task.id}>
      <div className="drawer-head">
        <div>
          <div className="role">{ROLE_NAME[task.role]} · {kindOf(task)}</div>
          <h3>{task.title}</h3>
          <StatusMark status={task.status} />
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={T.close}><IconClose className="icon sm" /></button>
      </div>
      <div className="seg drawer-tabs">
        <button type="button" aria-pressed={tab === 'art'} onClick={() => setTab('art')}>{T.tabArtifacts}</button>
        <button type="button" aria-pressed={tab === 'brief'} onClick={() => setTab('brief')}>{T.tabSummary}</button>
        <button type="button" aria-pressed={tab === 'ev'} onClick={() => setTab('ev')}>{T.tabEvents}</button>
      </div>
      <div className="drawer-body">
        {tab === 'art' && (task.artifacts.length
          ? task.artifacts.map((id) => <ArtifactView key={id} snap={snap} id={id} />)
          : <p className="muted">{T.noArtifacts} {task.status === 'failed' ? T.failedSeeEvents : ''}</p>)}
        {tab === 'brief' && (
          <>
            <dl className="kv">
              <dt>{T.kvRole}</dt><dd>{ROLE_NAME[task.role]}</dd>
              <dt>{T.kvWork}</dt><dd>{kindOf(task)}</dd>
              <dt>{T.kvRegion}</dt><dd>{task.region} {T.allowed(st.region?.allowedFiles.join(', ') ?? '')}</dd>
              <dt>{T.kvVersion}</dt><dd className="mono">{task.version}</dd>
              <dt>{T.kvRound}</dt><dd>{task.round} · {task.epoch}</dd>
              <dt>{T.kvInputs}</dt><dd className="mono small">{task.inputs.join(' · ') || '—'}</dd>
              <dt>{T.kvHandoff}</dt><dd>{task.handoffTo ? HANDOFF_TO[task.handoffTo] ?? task.handoffTo : '—'}</dd>
              <dt>{T.kvInstances}</dt>
              <dd>{task.instances.length ? task.instances.map((i) => (
                <div key={i.id} className="mono small">{i.id} · {i.model}{i.promptVersion ? ` · ${i.promptVersion}` : ''} · {i.status ?? T.inProgress}{i.model !== 'program' && i.status ? ` · ${i.usdUnknown ? T.unknownCost : usd(i.usd)}` : ''}{i.ms ? ` · ${(i.ms / 1000).toFixed(1)}s` : ''}{i.code ? ` · ${i.code}` : ''}</div>
              )) : '—'}</dd>
            </dl>
            {handoff && <><h4 className="sub">{T.handoffUsed}</h4><ArtifactView snap={snap} id={handoff.id} /></>}
          </>
        )}
        {tab === 'ev' && (
          <ol className="timeline compact">
            {evs.map((e) => <li key={e.seq}><time>{hhmmss(e.ts)}</time><span>{eventText(e, st.tasks) ?? e.type}</span></li>)}
          </ol>
        )}
      </div>
      <div className="drawer-foot">
        <button type="button" className="btn ghost" onClick={onLocate}>{T.locate}</button>
      </div>
    </aside>
  );
}
