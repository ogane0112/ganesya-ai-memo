import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Self-hosted fonts (CSP allows only same-origin): Inter for Latin, Noto Sans JP for Japanese, JetBrains Mono for code.
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-jp';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
