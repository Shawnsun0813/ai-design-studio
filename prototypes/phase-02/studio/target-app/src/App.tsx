import InfoPanel from './components/InfoPanel.tsx';
import NotesPanel from './components/NotesPanel.tsx';

export default function App() {
  return (
    <main className="page">
      <header className="site-head">
        <h1>Riverside Library</h1>
        <p>Community branch · sample site for the Phase 01 page chain</p>
      </header>
      <div className="grid">
        <InfoPanel />
        <NotesPanel />
      </div>
    </main>
  );
}
