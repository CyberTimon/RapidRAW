import { invoke } from '@tauri-apps/api/core';
import { ImageFile } from '../ui/AppProperties';

export const IMMICH_ALBUM_PREFIX = 'immich:';
const FILTER_MARKER = '?';

export const isImmichAlbumId = (albumId: string | null | undefined): albumId is string =>
  !!albumId && albumId.startsWith(IMMICH_ALBUM_PREFIX);

export const toImmichAlbumId = (immichId: string) => `${IMMICH_ALBUM_PREFIX}${immichId}`;

export const ImmichInvokes = {
  GetApiKey: 'immich_get_api_key',
  SetApiKey: 'immich_set_api_key',
  TestConnection: 'immich_test_connection',
  ListAlbums: 'immich_list_albums',
  GetImages: 'immich_get_images',
  Timeline: 'immich_timeline',
  SyncStatus: 'immich_sync_status',
  Flush: 'immich_flush',
  PrepareExport: 'immich_prepare_export',
  RemoveFromAlbum: 'immich_remove_from_album',
} as const;

export interface ImmichSettings {
  serverUrl: string;
  cacheLimitGb: number;
  exportAlbum: string;
  exportWithOriginal: boolean;
}

export const DEFAULT_IMMICH_SETTINGS: ImmichSettings = {
  serverUrl: '',
  cacheLimitGb: 20,
  exportAlbum: 'source',
  exportWithOriginal: true,
};

export interface ImmichApiKeyInfo {
  apiKey: string;
  inCredentialStore: boolean;
}

export interface ImmichAlbum {
  id: string;
  albumName: string;
  assetCount: number;
  albumThumbnailAssetId: string | null;
  shared: boolean;
}

export interface ImmichTimelineMonth {
  timeBucket: string;
  count: number;
}

export interface ImmichSyncStatus {
  offline: boolean;
  pending: number;
}

export interface ImmichConnectionInfo {
  version: string;
  userName: string;
  userEmail: string;
}

export interface ImmichFilter {
  albumId?: string | null;
  takenFrom?: string | null;
  takenUntil?: string | null;
}

export const filterToAlbumId = (filter: ImmichFilter) =>
  `${IMMICH_ALBUM_PREFIX}${FILTER_MARKER}${JSON.stringify(filter)}`;

export const albumIdToFilter = (albumId: string): ImmichFilter => {
  const rest = albumId.slice(IMMICH_ALBUM_PREFIX.length);
  if (rest.startsWith(FILTER_MARKER)) {
    try {
      return JSON.parse(rest.slice(FILTER_MARKER.length));
    } catch {
      return {};
    }
  }
  return { albumId: rest };
};

export const immichAlbumOf = (albumId: string | null | undefined) => {
  if (!isImmichAlbumId(albumId)) return null;
  const rest = albumId.slice(IMMICH_ALBUM_PREFIX.length);
  return rest.startsWith(FILTER_MARKER) ? null : rest;
};

export const removeFromImmichAlbum = (albumId: string, paths: string[]) =>
  invoke<void>(ImmichInvokes.RemoveFromAlbum, { albumId, paths });

export const getImmichApiKey = () => invoke<ImmichApiKeyInfo>(ImmichInvokes.GetApiKey);

export const setImmichApiKey = (apiKey: string) => invoke<ImmichApiKeyInfo>(ImmichInvokes.SetApiKey, { apiKey });

export const testImmichConnection = (serverUrl: string, apiKey: string) =>
  invoke<ImmichConnectionInfo>(ImmichInvokes.TestConnection, { serverUrl, apiKey });

export const listImmichAlbums = () => invoke<ImmichAlbum[]>(ImmichInvokes.ListAlbums);

export const listImmichTimeline = () => invoke<ImmichTimelineMonth[]>(ImmichInvokes.Timeline);

export const monthFilter = (timeBucket: string): ImmichFilter => {
  const [year, month] = timeBucket.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  return { takenFrom: `${year}-${mm}-01`, takenUntil: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
};

export const getImmichAlbumImages = (albumId: string) =>
  invoke<ImageFile[]>(ImmichInvokes.GetImages, { filter: albumIdToFilter(albumId) });

export const getImmichSyncStatus = () => invoke<ImmichSyncStatus>(ImmichInvokes.SyncStatus);

export const flushImmichEdits = () => invoke<ImmichSyncStatus>(ImmichInvokes.Flush);

export const prepareImmichExport = (album: string, withOriginal: boolean) =>
  invoke<string>(ImmichInvokes.PrepareExport, { album, withOriginal });
