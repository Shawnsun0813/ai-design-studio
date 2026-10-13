import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './base.css';

// Dev-only integration: lets the workbench select registered regions.
if (import.meta.env.DEV) {
  import('./chain-bridge.ts');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
