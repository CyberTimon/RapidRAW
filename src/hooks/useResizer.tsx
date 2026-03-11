import { useState } from 'react';
import { Direction, Orientation } from '../components/ui/AppProperties';
import ResizerComponent from '../components/ui/Resizer';

interface useResizerProps {
  defaultSize?: number;
  maxSize?: number;
  minSize?: number;
  orientation?: Orientation;
  direction?: Direction;
}

export function useResizer({
  defaultSize,
  maxSize = 0,
  minSize = 0,
  orientation = Orientation.Horizontal,
  direction = Direction.Left,
}: useResizerProps = {}) {
  const [isResizing, setIsResizing] = useState(false);
  const [size, setSize] = useState(defaultSize ?? 0);

  const handler = (event: MouseEvent) => {
    event.preventDefault();
    setIsResizing(true);

    const startX = event.clientX;
    const startY = event.clientY;

    const doDrag = (moveEvent: MouseEvent) => {
      if (orientation === Orientation.Vertical && direction === Direction.Right) {
        setSize(Math.max(minSize, Math.min(size + (moveEvent.clientX - startX), maxSize)));
      } else if (orientation === Orientation.Vertical && direction === Direction.Left) {
        setSize(Math.max(minSize, Math.min(size - (moveEvent.clientX - startX), maxSize)));
      } else if (orientation === Orientation.Horizontal && direction === Direction.Up) {
        setSize(Math.max(minSize, Math.min(size - (moveEvent.clientY - startY), maxSize)));
      } else if (orientation === Orientation.Horizontal && direction === Direction.Down) {
        setSize(Math.max(minSize, Math.min(size + (moveEvent.clientY - startY), maxSize)));
      } else {
        console.error(`Incompatible direction and orientation: ${orientation} ${direction}`);
      }
    };

    const stopDrag = () => {
      document.documentElement.style.cursor = '';
      window.removeEventListener('mousemove', doDrag);
      window.removeEventListener('mouseup', stopDrag);
      setIsResizing(false);
    };

    document.documentElement.style.cursor = orientation === Orientation.Horizontal ? 'row-resize' : 'col-resize';
    window.addEventListener('mousemove', doDrag);
    window.addEventListener('mouseup', stopDrag);
  };

  const Resizer = () => <ResizerComponent direction={orientation} onMouseDown={handler} />;

  return { isResizing, size, setSize, handler, Resizer };
}
