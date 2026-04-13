import { PropsWithChildren } from 'react';
import { Panel as GenericPanel } from '../../ui/GenericPanel';
import { LucideIcon } from 'lucide-react';

export function PanelHeader({ children, title, tooltip }: PropsWithChildren<{ title?: string; tooltip?: string }>) {
  return (
    <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
      <h2 className="text-xl font-bold text-primary text-shadow-shiny">{title ?? tooltip}</h2>
      {children}
    </div>
  );
}

export function PanelBody({ children }: PropsWithChildren) {
  return <div className="flex flex-col h-full">{children}</div>;
}

export function Panel({
  title,
  tooltip,
  children,
  icon,
}: PropsWithChildren<{ tooltip?: string; title?: string; icon: LucideIcon }>) {
  return (
    <GenericPanel
      barComponent={icon}
      title={title}
      tooltip={tooltip}
      body={({ children }) => {
        return (
          <PanelBody>
            <PanelHeader tooltip={tooltip} title={title} />
            {children}
          </PanelBody>
        );
      }}
    >
      {children}
    </GenericPanel>
  );
}
