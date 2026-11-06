import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import ViewerWindow from './window/ViewerWindow';
import { installFrontendLogBridge } from './utils/frontendLogBridge';
import './styles.css';

installFrontendLogBridge();

const isViewerWindow = getCurrentWindow().label === 'viewer';

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode>{isViewerWindow ? <ViewerWindow /> : <App />}</React.StrictMode>);
