import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { ModalBloc } from '../../blocs/app/ModalBloc';
import { Button } from '../../primitives/Button';

export function AboutModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('about');

  if (!isOpen) return null;

  const handleOpenGithub = () => {
    window.open('https://github.com/CyberTimon/RapidRAW', '_blank');
  };

  const handleOpenDocs = () => {
    window.open('https://rapidraw.app/docs', '_blank');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => modalBloc.close('about')}
      title="About RapidRAW"
      size="sm"
    >
      <div className="text-center">
        <div className="mb-6">
          <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-accent to-accent/60 flex items-center justify-center">
            <svg
              width={48}
              height={48}
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-text-primary">RapidRAW</h2>
          <p className="text-sm text-text-secondary mt-1">Version 1.0.0</p>
        </div>

        <p className="text-sm text-text-secondary mb-6">
          A fast, modern RAW photo editor built with Rust and React.
          Process your photos with blazing speed and intuitive controls.
        </p>

        <div className="space-y-2 mb-6">
          <Button variant="ghost" className="w-full justify-center" onClick={handleOpenGithub}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" className="mr-2">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            View on GitHub
          </Button>
          <Button variant="ghost" className="w-full justify-center" onClick={handleOpenDocs}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            Documentation
          </Button>
        </div>

        <div className="text-xs text-text-secondary pt-4 border-t border-border-color">
          <p>Built with Tauri, React, and Rust</p>
          <p className="mt-1">MIT License</p>
        </div>
      </div>
    </Modal>
  );
}
