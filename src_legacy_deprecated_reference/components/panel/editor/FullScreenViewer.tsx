import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { TransformState } from '../../ui/AppProperties';

interface FullscreenViewerProps {
  isOpen: boolean;
  onClose(): void;
  onTransformChange(state: TransformState): void;
  thumbnailUrl: string;
  transformState: TransformState;
  url: string | null;
}

const FullScreenViewer = memo(
  ({ isOpen, onClose, onTransformChange, thumbnailUrl, transformState, url }: FullscreenViewerProps) => {
    const [isMounted, setIsMounted] = useState(false);
    const [show, setShow] = useState(false);
    const [isFullResLoaded, setIsFullResLoaded] = useState(false);

    useEffect(() => {
      if (isOpen) {
        setIsMounted(true);
        const timer = setTimeout(() => {
          setShow(true);
        }, 10);
        return () => clearTimeout(timer);
      } else {
        setShow(false);
        const timer = setTimeout(() => {
          setIsMounted(false);
        }, 300);
        return () => clearTimeout(timer);
      }
    }, [isOpen]);

    useEffect(() => {
      if (isOpen) {
        setIsFullResLoaded(false);
      }
    }, [isOpen, thumbnailUrl]);

    const handleClose = useCallback(() => {
      if (onClose) {
        onClose();
      }
    }, [onClose]);

    useEffect(() => {
      const handleKeyDown = (e: any) => {
        if (e.key === 'Escape' || e.key === 'f') {
          handleClose();
        }
      };

      if (isOpen) {
        window.addEventListener('keydown', handleKeyDown);
      }

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [isOpen, handleClose]);

    const doubleClickProps: any = useMemo(() => {
      return {
        animationTime: 200,
        animationType: 'easeOut',
        mode: transformState.scale >= 2 ? 'reset' : 'zoomIn',
      };
    }, [transformState.scale]);

    if (!isMounted) {
      return null;
    }

    // TODO: positionX, positionY and scale are not supported properties?
    return (
      <div
        aria-modal="true"
        className={clsx(
          'fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 ease-in-out',
          show ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
        role="dialog"
      >
        <button
          className={clsx(
            'absolute top-4 right-4 text-white hover:text-gray-300 z-[102] transition-opacity duration-300',
            show ? 'opacity-100' : 'opacity-0',
          )}
          onClick={(e: any) => {
            e.stopPropagation();
            handleClose();
          }}
          title="Close (Esc or F)"
        >
          <X size={32} />
        </button>

        <div
          className={clsx(
            'w-full h-full flex items-center justify-center transform transition-all duration-300 ease-out',
            show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4',
          )}
        >
          <TransformWrapper
            doubleClick={doubleClickProps}
            limitToBounds={true}
            maxScale={10}
            minScale={0.8}
            onTransformed={(_, state: TransformState) => onTransformChange(state)}
            positionX={transformState.positionX}
            positionY={transformState.positionY}
            scale={transformState.scale}
          >
            <TransformComponent
              contentStyle={{
                alignItems: 'center',
                display: 'flex',
                height: '100%',
                justifyContent: 'center',
                width: '100%',
              }}
              wrapperStyle={{ width: '100%', height: '100%' }}
            >
              <div onClick={(e: any) => e.stopPropagation()}>
                <div className="relative">
                  <img
                    alt="Preview"
                    className="w-auto h-[90vh] max-w-[95vw] object-contain"
                    onContextMenu={(e: any) => e.preventDefault()}
                    src={thumbnailUrl}
                  />
                  {url && (
                    <img
                      alt="Fullscreen Preview"
                      className={clsx(
                        'absolute top-0 left-0 w-full h-full object-contain transition-opacity duration-300',
                        isFullResLoaded ? 'opacity-100' : 'opacity-0',
                      )}
                      onContextMenu={(e: any) => e.preventDefault()}
                      onLoad={() => setIsFullResLoaded(true)}
                      src={url}
                    />
                  )}
                </div>
              </div>
            </TransformComponent>
          </TransformWrapper>
        </div>
      </div>
    );
  },
);

export default FullScreenViewer;
