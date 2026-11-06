import clsx from 'clsx';
import type { MouseEventHandler, PointerEventHandler } from 'react';
import { Orientation } from './AppProperties';

interface ResizerProps {
  direction: Orientation;
  onMouseDown: PointerEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
}

const Resizer = ({ direction, onMouseDown, onDoubleClick }: ResizerProps) => (
  <div
    className={clsx('shrink-0 bg-transparent z-10 touch-none', {
      'w-2 cursor-col-resize': direction === Orientation.Vertical,
      'h-2 cursor-row-resize': direction === Orientation.Horizontal,
    })}
    role="separator"
    aria-orientation={direction === Orientation.Vertical ? 'vertical' : 'horizontal'}
    onPointerDown={onMouseDown}
    onDoubleClick={onDoubleClick}
    style={{ touchAction: 'none' }}
  />
);

export default Resizer;
