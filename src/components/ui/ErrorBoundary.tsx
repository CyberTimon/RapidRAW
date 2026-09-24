import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home, Copy, Check } from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import { useUIStore } from '../../store/useUIStore';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    copied: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
      copied: false,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary caught error]:', error, errorInfo?.componentStack);
  }

  private handleResetToLibrary = () => {
    try {
      useEditorStore.getState().setEditor({ selectedImage: null });
      useUIStore.getState().setUI({ activeView: 'library' });
    } catch (_) {}
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleCopyError = () => {
    const details = [
      this.state.error?.name,
      this.state.error?.message,
      this.state.error?.stack,
      this.state.errorInfo?.componentStack,
    ]
      .filter(Boolean)
      .join('\n\n');

    navigator.clipboard.writeText(details).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full min-h-[300px] flex flex-col items-center justify-center p-6 bg-bg-primary text-text-primary select-none">
          <div className="max-w-md w-full bg-card-bg border border-red-500/40 rounded-xl p-6 shadow-2xl flex flex-col items-center text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center text-red-400 border border-red-500/20">
              <AlertTriangle size={28} />
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-semibold text-text-primary">
                {this.props.fallbackTitle || 'A rendering error occurred'}
              </h2>
              <p className="text-xs text-text-secondary">
                The application encountered an unexpected issue while rendering this view.
              </p>
            </div>

            {this.state.error && (
              <div className="w-full text-left bg-black/40 border border-white/10 rounded-lg p-3 text-[11px] font-mono text-red-300 max-h-32 overflow-y-auto custom-scrollbar">
                {this.state.error.message || String(this.state.error)}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-2 pt-2 w-full">
              <button
                type="button"
                onClick={this.handleResetToLibrary}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-text hover:bg-accent-hover text-xs font-medium transition-colors cursor-pointer shadow-sm"
              >
                <Home size={14} />
                <span>Return to Library</span>
              </button>

              <button
                type="button"
                onClick={this.handleReload}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface hover:bg-card-active text-text-primary border border-border-color text-xs font-medium transition-colors cursor-pointer"
              >
                <RefreshCw size={14} />
                <span>Reload App</span>
              </button>

              <button
                type="button"
                onClick={this.handleCopyError}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface/50 hover:bg-card-active text-text-secondary border border-border-color text-xs font-medium transition-colors cursor-pointer"
                title="Copy error details to clipboard"
              >
                {this.state.copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                <span>{this.state.copied ? 'Copied' : 'Copy Error'}</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
