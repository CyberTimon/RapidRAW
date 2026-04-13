import React, {
  Children,
  isValidElement,
  useState,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from 'react';

const PanelElement = {
  Panel: 'panel',
  Group: 'panel-group',
  Body: 'panel-body',
} as const;

type PanelComponent = ComponentType<Partial<Omit<ParsedPanel, 'buttonElement' | 'body'>>>;

type PanelProps = PropsWithChildren<{
  title?: string;
  tooltip?: string;
  barComponent?: PanelComponent;
  body?: PanelComponent;
}>;

type ParsedPanel = PanelProps & {
  index: number;
  group?: number;
};

export const Panel: React.FC<PanelProps> = () => null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Panel as any).$$type = PanelElement.Panel;

type PanelGroupProps = PropsWithChildren;

export const PanelGroup: React.FC<PanelGroupProps> = () => null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(PanelGroup as any).$$type = PanelElement.Group;

type PanelRootProps = PropsWithChildren<{
  barComponent?: ComponentType<{ panels: ParsedPanel[] }>;
}>;

export function PanelRoot({ children, barComponent: BarComponent }: PanelRootProps) {
  const panels: ParsedPanel[] = parsePanels(children);

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const activePanel = activeIndex !== null ? panels[activeIndex] : undefined;

  const handleClick = (clickedIndex: number) => {
    if (clickedIndex === activeIndex) {
      setActiveIndex(null);
    } else {
      setActiveIndex(clickedIndex);
    }
  };

  return (
    <>
      {BarComponent ? (
        <BarComponent panels={panels} />
      ) : (
        panels.map(({ index, barComponent: ButtonElement, title, ...args }) => {
          return (
            <button onClick={() => handleClick(index)}>
              {ButtonElement ? <ButtonElement title={title} index={index} {...args} /> : <>{title}</>}
            </button>
          );
        })
      )}
      {activePanel &&
        activePanel.body &&
        (() => {
          const Body = activePanel.body;
          return <Body {...activePanel} />;
        })()}
    </>
  );
}

function isPanel(el: ReactNode): el is ReactElement<PanelProps> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return isValidElement(el) && (el.type as any).$$type === PanelElement.Panel;
}

function isPanelGroup(el: ReactNode): el is ReactElement<PanelGroupProps> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return isValidElement(el) && (el.type as any).$$type === PanelElement.Group;
}

function parsePanels(children: ReactNode) {
  const panels: ParsedPanel[] = [];

  let groupIndex = 0;
  let panelIndex = 0;

  parse(children);

  function parse(childrenInternal: ReactNode) {
    console.log('parse');

    for (const child of Children.toArray(childrenInternal)) {
      if (isPanel(child)) {
        panels.push({
          index: panelIndex,
          ...child.props,
          body: child.props.body ?? (() => <>{child.props.children}</>),
        });
        panelIndex++;
        continue;
      }

      if (isPanelGroup(child)) {
        for (const node of Children.toArray(child.props.children)) {
          if (!isPanel(node)) {
            if (isValidElement(node)) parse(node);
            continue;
          }

          panels.push({
            index: panelIndex,
            group: groupIndex,
            ...node.props,
            body: node.props.body ?? (() => <>{node.props.children}</>),
          });
          panelIndex++;
          continue;
        }

        groupIndex++;
        continue;
      }

      parse(child);
    }
  }

  return panels;
}
