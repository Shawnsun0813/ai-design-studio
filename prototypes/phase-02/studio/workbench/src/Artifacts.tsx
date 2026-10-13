// Readable views of real session artifacts (with the raw JSON one click away).
import { fileUrl, type Json, type Snapshot } from './api.ts';
import { ARTIFACT_NAME, OPERATOR, T } from './copy.ts';

export function Shots({ snap, data, compact }: { snap: Snapshot; data: Json; compact?: boolean }) {
  return (
    <div className="shots">
      {Object.entries(data.shots as Record<string, Json>).map(([w, s]) => (
        <div key={w} className="shot-group">
          <div className="small muted">{w} px · Show/Hide details {s.toggle?.ok ? 'works' : 'broken'}</div>
          <figure><img src={fileUrl(snap, s.region)} alt={`Region at ${w} px`} /><figcaption>Region</figcaption></figure>
          {!compact && <figure><img src={fileUrl(snap, s.expanded)} alt={`Expanded at ${w} px`} /><figcaption>Expanded</figcaption></figure>}
          {!compact && s.neighbour && <figure><img src={fileUrl(snap, s.neighbour)} alt={`Neighbour at ${w} px`} /><figcaption>Neighbour (kept)</figcaption></figure>}
        </div>
      ))}
    </div>
  );
}

function Body({ snap, kind, d, meta }: { snap: Snapshot; kind: string; d: Json; meta: Json }) {
  switch (kind) {
    case 'evidence-before':
    case 'evidence-after':
      return (
        <>
          <p className="small mono">{d.version?.label} · {d.version?.short} · {d.at}</p>
          <Shots snap={snap} data={d} />
          {d.roundDiff && <><b className="small">Diff for this round ({d.roundStart?.label} → running)</b><pre className="diff">{d.roundDiff}</pre></>}
        </>
      );
    case 'pm-plan':
      return (
        <>
          {d.mode && d.mode !== 'initial' && <p className="small"><b>{T.pmMode(d.mode)}</b></p>}
          <p>{d.restatement}</p>
          {d.changes?.length > 0 && <><b className="small">Changes this round</b><ul className="plain">{d.changes.map((c: string) => <li key={c}>{c}</li>)}</ul></>}
          <b className="small">Tasks this round</b><ol className="plain">{d.plan.map((x: Json, i: number) => <li key={i}><b>{x.role}</b> {x.task} → {x.deliverable}</li>)}</ol>
          <b className="small">Completion conditions (from your words)</b><ul className="plain">{d.goalCriteria.map((c: Json, i: number) => <li key={i}>G{i + 1} {c.text} <span className="muted">· {c.howToCheck}</span></li>)}</ul>
          <b className="small">Keep</b><ul className="plain">{d.keep.map((k: string) => <li key={k}>{k}</li>)}</ul>
          {d.supersedes?.length > 0 && <p className="small">Replaces earlier criteria: {d.supersedes.join(', ')}</p>}
          {d.outOfScope?.length > 0 && <><b className="small">Out of scope</b><ul className="plain">{d.outOfScope.map((k: string) => <li key={k}>{k}</li>)}</ul></>}
        </>
      );
    case 'interpretation':
      return <InterpList d={d} />;
    case 'proposals':
      return (
        <>
          <p className="small mono">Made for version {meta.baseVersion?.short}</p>
          {d.proposals.map((x: Json) => (
            <div key={x.id} className="prop">
              <div className="prop-head"><b>{x.id} · {x.name}</b>{x.id === d.recommended && <span className="rec">{T.recommended}</span>}<span className="kind-proposal">{T.propState.open}</span></div>
              <p>{x.intent}</p><ul>{x.changes.map((c: string) => <li key={c}>{c}</li>)}</ul>
              <p className="small muted">{x.referenceUse} {x.keepPromise}</p>
              <p className="small mono">digest {meta.digests?.[x.id]}</p>
            </div>
          ))}
          <p className="small">Recommends {d.recommended}: {d.why}</p>
        </>
      );
    case 'spec':
      return (
        <>
          <p>{d.summary}</p>
          {d.modificationApplied && <p className="small">{T.yourWords(d.modificationApplied)}</p>}
          <table className="rules"><tbody>{d.rules.map((r: Json, i: number) => <tr key={i}><td className="mono">{r.selector}</td><td className="mono">{r.property}: {r.value}</td><td className="muted">{r.why}</td></tr>)}</tbody></table>
          {d.states?.length > 0 && <><b className="small">Interaction states</b><ul className="plain">{d.states.map((s: Json, i: number) => <li key={i}><b>{s.state}</b> {s.spec}</li>)}</ul></>}
          <b className="small">Completion conditions</b><ul className="plain">{d.criteria.map((c: Json, i: number) => <li key={i}>S{i + 1} {c.text} <span className="muted">· {c.width} · {c.howToCheck}</span></li>)}</ul>
        </>
      );
    case 'handoff':
      return (
        <>
          <dl className="kv">
            <dt>Round</dt><dd>{d.round ?? 1}{d.mode && d.mode !== 'initial' ? ` · ${T.pmMode(d.mode)}` : ''}</dd>
            <dt>Goal</dt><dd>{d.goal}</dd>
            <dt>Region</dt><dd>{d.region.id} · may change {d.region.allowedFiles.join(', ')}</dd>
            <dt>Direction</dt><dd>{d.direction.id} · {d.direction.name} <span className="mono small">{d.direction.digest}</span></dd>
            <dt>Your words</dt><dd>{d.modification || '(none)'}</dd>
            <dt>Chosen by</dt><dd>{OPERATOR[d.chosenBy] ?? d.chosenBy}</dd>
            <dt>Reference</dt><dd>reading v{d.reference.version} · borrow {d.reference.borrow.length} · skip {d.reference.skip.length}</dd>
            <dt>Based on</dt><dd className="mono">{d.baseVersion.label} {d.baseVersion.short}</dd>
            <dt>Adopted</dt><dd>{d.adopted ? d.adopted.label : '—'}</dd>
            <dt>Replaces</dt><dd>{d.supersedes?.length ? d.supersedes.map((x: Json) => `${x.id} (${x.text})`).join('; ') : '—'}</dd>
            <dt>Not used</dt><dd>{d.notUsed?.join('; ') || '—'}</dd>
            <dt>Open issues</dt><dd>{d.openIssues.join('; ') || '—'}</dd>
          </dl>
          <b className="small">Completion conditions (frozen {d.frozenAt?.slice(11, 19)})</b>
          <ul className="plain">{d.criteria.map((c: Json) => <li key={c.id}><b className="mono">{c.id}</b> {c.text} <span className="muted">· {c.source}</span></li>)}</ul>
        </>
      );
    case 'patch':
      return (
        <>
          {meta.cycle === 'fix' && <p className="small"><b>Fix of the review issues</b></p>}
          {d.blocked && <p className="bad">{T.cannot(d.blocked)}</p>}
          <p className="small">{d.notes}</p>
          {d.edits.map((e: Json, i: number) => <pre key={i} className="diff">{`@@ ${e.file}\n${e.find.split('\n').map((l: string) => `- ${l}`).join('\n')}\n${e.replace.split('\n').map((l: string) => `+ ${l}`).join('\n')}`}</pre>)}
        </>
      );
    case 'diff':
      return <><p className="small mono">{d.file} · {d.before?.slice(0, 8)} → {d.after?.slice(0, 8)}</p><pre className="diff">{d.diff}</pre></>;
    case 'review':
      return <ReviewBody d={d} />;
    case 'reference':
      return <figure className="ref-full"><img src={fileUrl(snap, d.file)} alt="Reference image" /><figcaption>{d.name} · {d.w}×{d.h}</figcaption></figure>;
    default:
      return null;
  }
}

export function InterpList({ d }: { d: Json }) {
  return (
    <>
      {d.correctionApplied && <p className="small">{T.correctionApplied}: {d.correctionApplied}</p>}
      <ul className="uses-list">
        {d.borrow.map((x: Json, i: number) => <li key={`b${i}`}><b>{d.mode === 'no-reference' ? T.continueRule : T.borrow}</b><span>{x.rule} <span className="muted">· {x.aspect} · {x.appliesTo}</span></span></li>)}
        {d.skip.map((x: Json, i: number) => <li key={`s${i}`}><b className="no">{T.skip}</b><span>{x.aspect}: {x.reason}</span></li>)}
        {d.keep.map((x: string, i: number) => <li key={`k${i}`}><b className="keep">{T.keep}</b><span>{x}</span></li>)}
      </ul>
      {d.openQuestion && <p className="small">{T.openQuestion}: {d.openQuestion}</p>}
    </>
  );
}

export function ReviewBody({ d, criteria }: { d: Json; criteria?: Json[] }) {
  const text = (id: string) => criteria?.find((c) => c.id === id)?.text;
  return (
    <>
      <ul className="checks">
        {d.criteria.map((c: Json) => (
          <li key={c.id} className={c.verdict === 'pass' ? 'ok' : 'bad'}>
            <span className="mark">{c.verdict === 'pass' ? '✓' : c.verdict === 'fail' ? '✗' : '?'}</span>
            <span><b className="mono">{c.id}</b> {text(c.id) ? <>{text(c.id)} — </> : null}<span className="muted">{c.evidence}</span></span>
          </li>
        ))}
      </ul>
      {d.deviations.length > 0 && (
        <>
          <b className="small">{T.deviations}</b>
          <ul className="devs">{d.deviations.map((x: Json, i: number) => <li key={i}><span className="mono">{x.element} · {x.property} · {x.width}</span><br />{x.what}<br /><span className="muted">{T.impact}: {x.impact}</span><br /><b>{T.fixCondition}:</b> {x.fix}</li>)}</ul>
        </>
      )}
      {d.outOfScope.length > 0 && <><b className="small">{T.outOfScope}</b><ul className="plain">{d.outOfScope.map((x: string) => <li key={x}>{x}</li>)}</ul></>}
      <p className="small">{T.directionMatch}: {d.directionMatch} · {d.summary}</p>
    </>
  );
}

export function ArtifactView({ snap, id }: { snap: Snapshot; id: string }) {
  const a = snap.artifacts?.[id];
  if (!a) return null;
  const { data, ...meta } = a;
  return (
    <div className={`artifact k-${a.kind}`} data-artifact={a.kind}>
      <div className="art-kind">{ARTIFACT_NAME[a.kind] ?? a.kind}{meta.promptVersion ? ` · ${meta.model} · ${meta.promptVersion}` : ''}</div>
      <div className="art-body"><Body snap={snap} kind={a.kind} d={data} meta={meta} /></div>
      <details><summary className="small muted">{T.raw} · {id}</summary><pre className="raw">{JSON.stringify(a, null, 2).slice(0, 20000)}</pre></details>
    </div>
  );
}
