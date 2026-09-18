// Entry point de React 19 del renderer (doc 02 §1: apps/desktop/src/renderer/src/main.tsx).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';

const container = document.getElementById('root');
if (!container) throw new Error('saurio: #root no encontrado en index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
