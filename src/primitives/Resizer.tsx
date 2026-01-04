import { useRef, useCallback, useEffect } from 'react';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function Resizer({ direction, onResize, onResizeStart, onResizeEnd }: ResizerProps) {
  const isDragging = useRef(false);
  const lastPosition = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastPosition.current = direction === 'horizontal' ? e.clientY : e.clientX;
      onResizeStart?.();
      document.body.style.cursor = direction === 'horizontal' ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [direction, onResizeStart]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;

      const currentPosition = direction === 'horizontal' ? e.clientY : e.clientX;
      const delta = currentPosition - lastPosition.current;
      lastPosition.current = currentPosition;

      onResize(delta);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        onResizeEnd?.();
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [direction, onResize, onResizeEnd]);

  const isHorizontal = direction === 'horizontal';

  return (
    <div
      className={`
        ${isHorizontal ? 'h-1 w-full cursor-row-resize' : 'w-1 h-full cursor-col-resize'}
        bg-border-color hover:bg-accent transition-colors
        flex-shrink-0 group
      `}
      onMouseDown={handleMouseDown}
    >
      <div
        className={`
          ${isHorizontal ? 'h-full w-12 mx-auto' : 'w-full h-12 my-auto'}
          group-hover:bg-accent/20
        `}
      />
    </div>
  );
}
