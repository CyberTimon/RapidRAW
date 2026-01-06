import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { acquire, getPluginManager } from '@blac/core';
import { LoggingPlugin } from '@blac/logging-plugin';
import App from './App';
import './styles.css';
import { TauriService } from './blocs/services/TauriService';
import { KeyboardService } from './blocs/services/KeyboardService';
import { ClipboardService } from './blocs/services/ClipboardService';
import { ContextMenuService } from './blocs/services/ContextMenuService';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

getPluginManager().install(
  new LoggingPlugin({
    level: 'verbose',
  }),
);

acquire(TauriService);
acquire(KeyboardService);
acquire(ClipboardService);
acquire(ContextMenuService);

const root = createRoot(container);

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
