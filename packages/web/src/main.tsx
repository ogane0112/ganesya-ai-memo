import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Self-hosted fonts (CSP allows only same-origin): rounded Nunito for Latin,
// Zen Maru Gothic for Japanese (500 = body, 700 = bold), JetBrains Mono for code.
import '@fontsource-variable/nunito';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
