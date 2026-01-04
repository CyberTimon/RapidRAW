import clsx from 'clsx';
import { Orientation } from './AppProperties';

interface ResizerProps {
  direction: Orientation;
  onMouseDown: any;
}

const Resizer = ({ direction, onMouseDown }: ResizerProps) => (
  <div
    className={clsx('flex-shrink-0 bg-transparent z-10', {
      'w-2 cursor-col-resize': direction === Orientation.Vertical,
      'h-2 cursor-row-resize': direction === Orientation.Horizontal,
    })}
    onMouseDown={onMouseDown}
  />
);

export default Resizer;
