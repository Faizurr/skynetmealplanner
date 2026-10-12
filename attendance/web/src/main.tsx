import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { applyTheme, readThemePref } from './lib/theme';
import { initInstallCapture } from './lib/pwa';

applyTheme(readThemePref());
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(readThemePref()));
initInstallCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
