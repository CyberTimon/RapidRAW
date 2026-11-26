import { memo, type MouseEvent } from 'react';
import type { RowComponentProps } from 'react-window';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ChevronDown, Folder, FolderOpen } from 'lucide-react';
import Text from '../../ui/Text';
import { TextVariants, TextWeights } from '../../../types/typography';
import { ProxyState } from '../../../store/videoProxies';
import { colorLabelOf } from '../../../hooks/useSortedLibrary';
import BinTile from './BinTile';
import MediaTile, { KIND_ICONS } from './MediaTile';
import { PROJECT_DRAG_PREFIX } from './poolDrag';
import { PoolBlock, PoolHeader, PoolTile, folderLabel } from './poolEntries';
import { PoolMeta } from './poolMetadata';

export const ROW_PADDING_LEFT = 12;
export const ROW_PADDING_RIGHT = 2;
export const SCROLLBAR_WIDTH = 10;
export const GAP_X = 8;
export const GAP_Y = 12;
export const NAME_HEIGHT = 20;
export const HEADER_HEIGHT = 36;
const TOP_PADDING = 4;
const BOTTOM_PADDING = 12;

export type PoolRow =
  | { type: 'pad'; key: string; height: number }
  | { type: 'header'; key: string; header: PoolHeader }
  | { type: 'tiles'; key: string; tiles: Array<PoolTile> };

export interface PoolRowContext {
  columns: number;
  selected: ReadonlySet<string>;
  dragPaths: Array<string> | undefined;
  used: ReadonlySet<string>;
  files: Record<string, PoolMeta>;
  proxies: Record<string, ProxyState>;
  tooltips: Map<string, string> | null;
  renaming: string | null;
  draftName: string;
  isMissing(path: string): boolean;
  onSelect(id: string, event: MouseEvent): void;
  onActivate(id: string, path: string): void;
  onLocate(id: string): void;
  onAdd(path: string): void;
  onMenu(event: MouseEvent, id: string, isMissing: boolean): void;
  onOpenBin(id: string): void;
  onBinMenu(event: MouseEvent, id: string): void;
  onBinName(id: string | null, name: string | null): void;
  onRenameBin(id: string): void;
  onToggleGroup(key: string): void;
}

interface PoolRowProps {
  rows: Array<PoolRow>;
  context: PoolRowContext;
}

export const tileKey = (tile: PoolTile) =>
  tile.type === 'media' ? tile.media.id : tile.type === 'bin' ? tile.bin.id : 'draft';

export const layoutRows = (blocks: Array<PoolBlock>, columns: number): Array<PoolRow> => {
  const rows: Array<PoolRow> = [{ type: 'pad', key: 'top', height: TOP_PADDING }];
  for (const block of blocks) {
    if (block.header) rows.push({ type: 'header', key: `header:${block.header.key}`, header: block.header });
    for (let index = 0; index < block.tiles.length; index += columns) {
      const tiles = block.tiles.slice(index, index + columns);
      rows.push({ type: 'tiles', key: `tiles:${tileKey(tiles[0])}`, tiles });
    }
  }
  rows.push({ type: 'pad', key: 'bottom', height: BOTTOM_PADDING });
  return rows;
};

export const poolRowKey = (index: number, { rows }: PoolRowProps) => rows[index]?.key ?? index;

const GroupHeader = memo(function GroupHeader({
  header,
  onToggle,
}: {
  header: PoolHeader;
  onToggle(key: string): void;
}) {
  const { t } = useTranslation();
  const Icon =
    header.folder !== undefined ? (header.collapsed ? Folder : FolderOpen) : KIND_ICONS[header.kind ?? 'video'];
  const label =
    header.folder !== undefined ? folderLabel(header.folder) : t(`video.mediaPool.kinds.${header.kind ?? 'video'}`);
  return (
    <button
      type="button"
      className="group flex items-center gap-2 w-full min-w-0 border-b border-border-color/50 pb-1 text-left"
      onClick={() => onToggle(header.key)}
      aria-expanded={!header.collapsed}
    >
      <Icon size={15} className="shrink-0 text-text-secondary group-hover:text-text-primary transition-colors" />
      <Text
        as="span"
        variant={TextVariants.label}
        weight={TextWeights.semibold}
        className="truncate"
        data-tooltip={header.folder}
      >
        {label}
      </Text>
      <Text as="span" variant={TextVariants.small} className="ml-auto shrink-0 tabular-nums">
        {t('video.mediaPool.itemCount', { count: header.count })}
      </Text>
      <ChevronDown
        size={14}
        className={clsx(
          'shrink-0 text-text-secondary transition-transform duration-200',
          header.collapsed && '-rotate-90',
        )}
      />
    </button>
  );
});

function renderTile(tile: PoolTile, context: PoolRowContext) {
  if (tile.type === 'media') {
    const { media } = tile;
    const meta = context.files[media.path];
    const isSelected = context.selected.has(media.id);
    return (
      <MediaTile
        key={media.id}
        id={media.id}
        path={media.path}
        name={media.name}
        kind={media.kind}
        dragId={`${PROJECT_DRAG_PREFIX}${media.id}`}
        dragPaths={isSelected ? context.dragPaths : undefined}
        tooltip={context.tooltips?.get(media.id)}
        isSelected={isSelected}
        isMissing={context.isMissing(media.path)}
        isUsed={context.used.has(media.id)}
        proxy={context.proxies[media.path]}
        range={media.range}
        rating={meta?.rating}
        flag={meta?.flag}
        color={colorLabelOf(meta?.tags)}
        onSelect={context.onSelect}
        onActivate={context.onActivate}
        onLocate={context.onLocate}
        onAdd={context.onAdd}
        onMenu={context.onMenu}
      />
    );
  }
  const isDraft = tile.type === 'draft';
  return (
    <BinTile
      key={tileKey(tile)}
      id={isDraft ? null : tile.bin.id}
      name={isDraft ? context.draftName : tile.bin.name}
      count={isDraft ? 0 : tile.count}
      isEditing={isDraft || context.renaming === tile.bin.id}
      onOpen={context.onOpenBin}
      onMenu={context.onBinMenu}
      onRename={context.onBinName}
      onStartRename={context.onRenameBin}
    />
  );
}

export function PoolGridRow({ index, style, rows, context }: RowComponentProps<PoolRowProps>) {
  const row = rows[index];
  if (!row || row.type === 'pad') return null;
  if (row.type === 'header') {
    return (
      <div
        style={{ ...style, paddingLeft: ROW_PADDING_LEFT, paddingRight: ROW_PADDING_RIGHT }}
        className="flex items-end pb-2"
      >
        <GroupHeader header={row.header} onToggle={context.onToggleGroup} />
      </div>
    );
  }
  return (
    <div
      style={{
        ...style,
        display: 'grid',
        gridTemplateColumns: `repeat(${context.columns}, minmax(0, 1fr))`,
        columnGap: GAP_X,
        alignContent: 'start',
        paddingLeft: ROW_PADDING_LEFT,
        paddingRight: ROW_PADDING_RIGHT,
      }}
    >
      {row.tiles.map((tile) => renderTile(tile, context))}
    </div>
  );
}

export const rowHeightOf = (row: PoolRow | undefined, tileRowHeight: number) =>
  !row ? 0 : row.type === 'pad' ? row.height : row.type === 'header' ? HEADER_HEIGHT : tileRowHeight;
