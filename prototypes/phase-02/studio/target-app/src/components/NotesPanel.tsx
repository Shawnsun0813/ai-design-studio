import './NotesPanel.css';

// Not registered: the workbench must not guess a write location for this panel.
export default function NotesPanel() {
  return (
    <aside className="notes-panel" aria-labelledby="notes-title">
      <h2 id="notes-title">This week</h2>
      <ul>
        <li>Tue 18:00 · Reading group</li>
        <li>Thu 10:30 · Toddler rhyme time</li>
        <li>Sat 14:00 · Repair café</li>
      </ul>
    </aside>
  );
}
