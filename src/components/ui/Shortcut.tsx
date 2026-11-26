import clsx from 'clsx';

export default function Shortcut({ keys, className }: { keys?: string; className?: string }) {
  if (!keys) return null;
  return (
    <kbd
      className={clsx(
        'shrink-0 min-w-[18px] px-1 py-[3px] rounded-[4px] bg-text-secondary/10 text-center',
        'font-sans text-[11px] leading-none font-normal tracking-wide whitespace-nowrap text-text-secondary',
        className,
      )}
    >
      {keys}
    </kbd>
  );
}
