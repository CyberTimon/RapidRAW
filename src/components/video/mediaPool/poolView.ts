import { useMemo } from 'react';
import { create } from 'zustand';
import { FlagStatus, RatingOperator, SortDirection } from '../../../types/library';
import { MediaKind, MediaPoolTileSize, MediaPoolView } from '../../../types/video';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { currentProjectPath, getVideo, useCurrentProjectPath, useVideoStore } from '../../../store/useVideoStore';
import { findBin } from '../../../utils/video/bins';

export interface PoolFilters {
  show: 'all' | 'unused';
  kind: MediaKind | 'all';
  rating: number;
  ratingOperator: RatingOperator;
  flag: FlagStatus;
  colors: Array<string>;
}

export interface PoolSelection {
  ids: Array<string>;
  anchor: string | null;
  base: Array<string>;
}

export interface PoolDraft {
  parent: string | null;
  media: Array<string>;
}

interface PoolViewState {
  filters: PoolFilters;
  locations: Record<string, string>;
  collapsed: Record<string, true>;
  selection: PoolSelection | null;
  draft: PoolDraft | null;
  renaming: string | null;
}

export const DEFAULT_POOL_VIEW: MediaPoolView = {
  sort: 'imported',
  order: SortDirection.Ascending,
  group: 'none',
  size: 'medium',
};

export const DEFAULT_POOL_FILTERS: PoolFilters = {
  show: 'all',
  kind: 'all',
  rating: 0,
  ratingOperator: 'gte',
  flag: FlagStatus.All,
  colors: [],
};

export const TILE_WIDTHS: Record<MediaPoolTileSize, number> = { small: 72, medium: 96, large: 144 };

export const isPoolFiltered = (filters: PoolFilters) =>
  filters.show !== 'all' ||
  filters.kind !== 'all' ||
  filters.rating !== 0 ||
  filters.flag !== FlagStatus.All ||
  filters.colors.length > 0;

export const usePoolView = create<PoolViewState>(() => ({
  filters: DEFAULT_POOL_FILTERS,
  locations: {},
  collapsed: {},
  selection: null,
  draft: null,
  renaming: null,
}));

export const setPoolFilters = (patch: Partial<PoolFilters>) =>
  usePoolView.setState((state) => ({ filters: { ...state.filters, ...patch } }));

export const resetPoolFilters = () =>
  usePoolView.setState((state) => ({
    filters: { ...DEFAULT_POOL_FILTERS, ratingOperator: state.filters.ratingOperator },
  }));

export const usePoolSettings = () => {
  const stored = useSettingsStore((state) => state.appSettings?.videoMediaPool);
  return useMemo<MediaPoolView>(() => ({ ...DEFAULT_POOL_VIEW, ...stored }), [stored]);
};

export const updatePoolSettings = (patch: Partial<MediaPoolView>) => {
  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
  if (!appSettings) return;
  void handleSettingsChange({ ...appSettings, videoMediaPool: { ...appSettings.videoMediaPool, ...patch } });
};

export const useCurrentBin = () => {
  const path = useCurrentProjectPath();
  const stored = usePoolView((state) => (path ? (state.locations[path] ?? null) : null));
  return useVideoStore((state) => (findBin(state.project, stored) ? stored : null));
};

export const currentPoolBin = () => {
  const path = currentProjectPath();
  const stored = path ? usePoolView.getState().locations[path] : null;
  return stored && findBin(getVideo().project, stored) ? stored : null;
};

export const openBin = (id: string | null) => {
  const path = currentProjectPath();
  if (!path) return;
  usePoolView.setState((state) => {
    const { [path]: _previous, ...rest } = state.locations;
    return { locations: id ? { ...rest, [path]: id } : rest, draft: null, renaming: null, selection: null };
  });
};

export const toggleGroup = (key: string) =>
  usePoolView.setState((state) => {
    const { [key]: wasCollapsed, ...rest } = state.collapsed;
    return { collapsed: wasCollapsed ? rest : { ...rest, [key]: true } };
  });

export const setPoolSelection = (selection: PoolSelection | null) => usePoolView.setState({ selection });

export const startNewBin = (parent: string | null, media: Array<string> = []) =>
  usePoolView.setState({ draft: { parent, media }, renaming: null });

export const endNewBin = () => usePoolView.setState({ draft: null });

export const setRenamingBin = (renaming: string | null) => usePoolView.setState({ renaming, draft: null });
