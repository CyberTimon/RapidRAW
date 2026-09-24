import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { installFrontendLogBridge } from './utils/frontendLogBridge';
import './styles.css';

installFrontendLogBridge();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="Application Crash">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
