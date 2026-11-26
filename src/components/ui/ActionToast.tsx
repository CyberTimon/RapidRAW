interface ActionToastProps {
  message: string;
  detail?: string | null;
  action?: string;
  onAction?: () => void;
}

const ActionToast = ({ message, detail, action, onAction }: ActionToastProps) => (
  <div className="flex items-center justify-between gap-3 w-full">
    <p className="text-sm min-w-0 break-words line-clamp-2">
      {message}
      {detail && <span className="text-text-secondary"> {detail}</span>}
    </p>
    {action && onAction && (
      <button
        type="button"
        className="shrink-0 px-2.5 py-1 rounded-md bg-bg-primary text-xs font-medium text-text-primary hover:bg-card-active transition-colors"
        onClick={onAction}
      >
        {action}
      </button>
    )}
  </div>
);

export default ActionToast;
