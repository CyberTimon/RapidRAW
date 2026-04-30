import clsx from 'clsx';
import type { PointerEventHandler } from 'react';
import { Orientation } from './AppProperties';

interface ResizerProps {
  direction: Orientation;
  onMouseDown: PointerEventHandler<HTMLDivElement>;
}

const Resizer = ({ direction, onMouseDown }: ResizerProps) => (
  <div
    className={clsx('shrink-0 bg-transparent z-10 touch-none', {
      'w-2 cursor-col-resize': direction === Orientation.Vertical,
      'h-2 cursor-row-resize': direction === Orientation.Horizontal,
    })}
    role="separator"
    aria-orientation={direction === Orientation.Vertical ? 'vertical' : 'horizontal'}
    onPointerDown={onMouseDown}
    style={{ touchAction: 'none' }}
  />
);

export default Resizer;
