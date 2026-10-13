import { useState } from 'react';
import './InfoPanel.css';

export default function InfoPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section className="info-panel" data-region-id="info-panel" aria-labelledby="info-title">
      <p className="info-kicker">Visit</p>
      <h2 id="info-title" className="info-title">Opening hours and access</h2>
      <p className="info-lead">Open Monday to Saturday, 9:00–18:00. Closed on public holidays.</p>
      <dl className="info-facts">
        <div><dt>Address</dt><dd>12 River Road</dd></div>
        <div><dt>Step-free entry</dt><dd>Side door on Mill Lane</dd></div>
        <div><dt>Study rooms</dt><dd>Book at the front desk</dd></div>
      </dl>
      <button
        type="button"
        className="info-toggle"
        aria-expanded={open}
        aria-controls="info-details"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      <div id="info-details" className="info-details" hidden={!open}>
        <p>Children's corner closes at 17:00. Printing costs 10p per page.</p>
      </div>
    </section>
  );
}
