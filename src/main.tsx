import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

(() => {
  const root = document.documentElement;
  const stored = window.localStorage.getItem('remarcal_move.theme_mode');
  const mode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  root.classList.remove('theme-light', 'theme-dark');
  root.classList.add(resolved === 'dark' ? 'theme-dark' : 'theme-light');
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
