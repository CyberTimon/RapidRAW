import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Image as ImageIcon, Search } from 'lucide-react';
import Input from '../ui/Input';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { KEYBIND_DEFINITIONS, KEYBIND_SECTIONS, formatKeyCode } from '../../utils/keyboardUtils';
import { fuzzyMatch } from '../../utils/fuzzyMatch';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUIStore } from '../../store/useUIStore';

const MAX_RESULTS = 100;

type PaletteMode = 'actions' | 'files';

interface ActionEntry {
  action: string;
  combo: Array<string> | null;
  label: string;
  sectionLabel: string;
}

type PaletteRow =
  | { kind: 'search-files'; label: string; positions: Array<number> }
  | { kind: 'action'; entry: ActionEntry; positions: Array<number> }
  | { kind: 'file'; name: string; path: string; positions: Array<number> };

interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose(): void;
  onSelectFile(path: string): void;
}

function rowKey(row: PaletteRow): string {
  if (row.kind === 'search-files') return 'search-files';
  if (row.kind === 'action') return `action:${row.entry.action}`;
  return `file:${row.path}`;
}

function renderHighlighted(text: string, positions: Array<number>) {
  if (positions.length === 0) {
    return text;
  }
  const positionSet = new Set(positions);
  return text.split('').map((char, index) =>
    positionSet.has(index) ? (
      <span key={index} className="text-accent">
        {char}
      </span>
    ) : (
      char
    ),
  );
}

export default function CommandPaletteModal({ isOpen, onClose, onSelectFile }: CommandPaletteModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<PaletteMode>('actions');
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { appSettings, osPlatform } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      osPlatform: state.osPlatform,
    })),
  );
  const keybindActionRunner = useUIStore((state) => state.keybindActionRunner);
  const imageList = useLibraryStore((state) => state.imageList);
  const thumbnails = useProcessStore((state) => state.thumbnails);

  useEffect(() => {
    if (isOpen) {
      setMode('actions');
      setQuery('');
      setSelectedIndex(0);
      setIsMounted(true);
      const timer = setTimeout(() => {
        setShow(true);
      }, 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const actionEntries = useMemo<Array<ActionEntry>>(() => {
    if (!isOpen) {
      return [];
    }
    const userKeybinds = appSettings?.keybinds || {};
    const sectionLabels = new Map(KEYBIND_SECTIONS.map((section) => [section.id, t(section.label as any)]));
    return KEYBIND_DEFINITIONS.filter(
      (def) => def.action !== 'open_command_palette' && keybindActionRunner?.canRun(def.action),
    ).map((def) => {
      const userCombo = userKeybinds[def.action];
      const combo = userCombo !== undefined ? (userCombo.length ? userCombo : null) : def.defaultCombo;
      return {
        action: def.action,
        combo,
        label: t(def.description as any),
        sectionLabel: sectionLabels.get(def.section) || '',
      };
    });
  }, [isOpen, appSettings, keybindActionRunner, t]);

  const rows = useMemo<Array<PaletteRow>>(() => {
    if (!isOpen) {
      return [];
    }
    if (mode === 'actions') {
      const searchFilesLabel = t('modals.commandPalette.searchFiles');
      if (!query) {
        return [
          { kind: 'search-files', label: searchFilesLabel, positions: [] },
          ...actionEntries.map((entry) => ({ kind: 'action' as const, entry, positions: [] })),
        ];
      }
      const scored: Array<{ row: PaletteRow; score: number }> = [];
      const searchFilesMatch = fuzzyMatch(query, searchFilesLabel);
      if (searchFilesMatch) {
        scored.push({
          row: { kind: 'search-files', label: searchFilesLabel, positions: searchFilesMatch.positions },
          score: searchFilesMatch.score,
        });
      }
      for (const entry of actionEntries) {
        const match = fuzzyMatch(query, entry.label);
        if (match) {
          scored.push({ row: { kind: 'action', entry, positions: match.positions }, score: match.score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, MAX_RESULTS).map((item) => item.row);
    }
    const files = imageList.map((file) => ({
      path: file.path,
      name: file.path.split(/[\\/]/).pop() || file.path,
    }));
    if (!query) {
      return files.slice(0, MAX_RESULTS).map((file) => ({ kind: 'file' as const, ...file, positions: [] }));
    }
    const scored: Array<{ row: PaletteRow; score: number }> = [];
    for (const file of files) {
      const match = fuzzyMatch(query, file.name);
      if (match) {
        scored.push({ row: { kind: 'file', ...file, positions: match.positions }, score: match.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((item) => item.row);
  }, [isOpen, mode, query, actionEntries, imageList, t]);

  const clampedIndex = Math.min(selectedIndex, Math.max(rows.length - 1, 0));

  useEffect(() => {
    const selected = listRef.current?.querySelector('[data-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex, rows]);

  if (!isMounted) {
    return null;
  }

  const backToActions = () => {
    setMode('actions');
    setQuery('');
    setSelectedIndex(0);
  };

  const executeRow = (row: PaletteRow) => {
    if (row.kind === 'search-files') {
      setMode('files');
      setQuery('');
      setSelectedIndex(0);
      return;
    }
    onClose();
    if (row.kind === 'action') {
      keybindActionRunner?.run(row.entry.action);
    } else {
      onSelectFile(row.path);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length === 0) {
        return;
      }
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setSelectedIndex((clampedIndex + delta + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      const row = rows[clampedIndex];
      if (row) {
        executeRow(row);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      if (mode === 'files') {
        backToActions();
      } else {
        onClose();
      }
    } else if (e.key === 'Backspace' && mode === 'files' && query === '') {
      e.preventDefault();
      backToActions();
    }
  };

  return (
    <div
      aria-label={t('modals.commandPalette.title')}
      aria-modal="true"
      className={`
        fixed inset-0 flex items-start justify-center z-50 pt-[12vh]
        bg-black/30 backdrop-blur-xs
        transition-opacity duration-300 ease-in-out
        ${show ? 'opacity-100' : 'opacity-0'}
      `}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`
          bg-surface rounded-lg shadow-xl w-full max-w-xl overflow-hidden
          transform transition-all duration-300 ease-out
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}
        `}
        onClick={(e: any) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 p-3 border-b border-border-color">
          <Search size={18} className="text-text-secondary shrink-0" />
          {mode === 'files' && (
            <Text
              variant={TextVariants.small}
              color={TextColors.secondary}
              weight={TextWeights.semibold}
              className="px-2 py-1 bg-bg-primary rounded-md shrink-0"
            >
              {t('modals.commandPalette.files')}
            </Text>
          )}
          <Input
            autoFocus={true}
            bgClassName="bg-transparent"
            className="border-none h-8 px-1 focus-visible:ring-0"
            onChange={(e: any) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={
              mode === 'files' ? t('modals.commandPalette.filePlaceholder') : t('modals.commandPalette.placeholder')
            }
            value={query}
          />
        </div>
        <div aria-orientation="vertical" className="max-h-80 overflow-y-auto p-2" ref={listRef} role="listbox">
          {rows.length === 0 ? (
            <Text variant={TextVariants.label} color={TextColors.secondary} className="px-3 py-2">
              {t('modals.commandPalette.noResults')}
            </Text>
          ) : (
            rows.map((row, index) => {
              const isSelected = index === clampedIndex;
              return (
                <button
                  aria-selected={isSelected}
                  className={`
                    w-full text-left px-3 py-2 rounded-md flex items-center gap-3
                    transition-colors duration-150
                    ${isSelected ? 'bg-bg-primary' : 'hover:bg-bg-primary'}
                  `}
                  data-selected={isSelected}
                  key={rowKey(row)}
                  onClick={() => executeRow(row)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  role="option"
                >
                  {row.kind === 'search-files' && (
                    <>
                      <Search size={16} className="text-text-secondary shrink-0" />
                      <Text variant={TextVariants.label} color={TextColors.primary} className="flex-1 truncate">
                        {renderHighlighted(row.label, row.positions)}
                      </Text>
                    </>
                  )}
                  {row.kind === 'action' && (
                    <>
                      <Text variant={TextVariants.label} color={TextColors.primary} className="flex-1 truncate">
                        {renderHighlighted(row.entry.label, row.positions)}
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="shrink-0">
                        {row.entry.sectionLabel}
                      </Text>
                      {row.entry.combo && (
                        <Text
                          as="kbd"
                          variant={TextVariants.small}
                          color={TextColors.secondary}
                          weight={TextWeights.semibold}
                          className="px-2 py-1 font-sans bg-bg-primary border border-border-color rounded-md shrink-0"
                        >
                          {row.entry.combo.map((key) => formatKeyCode(key, osPlatform)).join(' + ')}
                        </Text>
                      )}
                    </>
                  )}
                  {row.kind === 'file' && (
                    <>
                      {thumbnails[row.path] ? (
                        <img
                          alt={row.name}
                          className="w-8 h-8 object-cover rounded shrink-0"
                          src={thumbnails[row.path]}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded bg-bg-primary flex items-center justify-center shrink-0">
                          <ImageIcon size={14} className="text-text-secondary" />
                        </div>
                      )}
                      <Text variant={TextVariants.label} color={TextColors.primary} className="flex-1 truncate">
                        {renderHighlighted(row.name, row.positions)}
                      </Text>
                    </>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
