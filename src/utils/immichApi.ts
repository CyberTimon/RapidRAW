import { invoke } from '@tauri-apps/api/core';
import { ImageFile } from '../types/library';
import { ImmichSettings } from '../types/settings';

export const IMMICH_ALBUM_PREFIX = 'immich:';
export const IMMICH_UNASSIGNED_ID = `${IMMICH_ALBUM_PREFIX}unassigned`;
const FILTER_MARKER = '?';

export const isImmichAlbumId = (albumId: string | null | undefined): albumId is string =>
  !!albumId && albumId.startsWith(IMMICH_ALBUM_PREFIX);

export const toImmichAlbumId = (immichId: string) => `${IMMICH_ALBUM_PREFIX}${immichId}`;

export const ImmichInvokes = {
  GetApiKey: 'immich_get_api_key',
  SetApiKey: 'immich_set_api_key',
  TestConnection: 'immich_test_connection',
  ListAlbums: 'immich_list_albums',
  CreateAlbum: 'immich_create_album',
  GetImages: 'immich_get_images',
  Timeline: 'immich_timeline',
  SyncStatus: 'immich_sync_status',
  Flush: 'immich_flush',
  PrepareExport: 'immich_prepare_export',
  RemoveFromAlbum: 'immich_remove_from_album',
  MediaRefs: 'immich_media_refs',
  LinkMedia: 'immich_link_media',
  CancelDownload: 'immich_cancel_download',
} as const;

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
  startDate: string | null;
  endDate: string | null;
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

export interface ImmichMediaRef {
  server: string;
  asset: string;
}

export interface ImmichOriginal {
  path: string;
  missing: boolean;
}

export interface ImmichFilter {
  albumId?: string | null;
  notInAlbum?: boolean;
  takenFrom?: string | null;
  takenUntil?: string | null;
}

export const filterToAlbumId = (filter: ImmichFilter) =>
  `${IMMICH_ALBUM_PREFIX}${FILTER_MARKER}${JSON.stringify(filter)}`;

export const albumIdToFilter = (albumId: string): ImmichFilter => {
  const rest = albumId.slice(IMMICH_ALBUM_PREFIX.length);
  if (rest === 'unassigned') return { notInAlbum: true };
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
  return rest.startsWith(FILTER_MARKER) || rest === 'unassigned' ? null : rest;
};

export const removeFromImmichAlbum = (albumId: string, paths: string[]) =>
  invoke<void>(ImmichInvokes.RemoveFromAlbum, { albumId, paths });

export const getImmichApiKey = () => invoke<ImmichApiKeyInfo>(ImmichInvokes.GetApiKey);

export const setImmichApiKey = (apiKey: string) => invoke<ImmichApiKeyInfo>(ImmichInvokes.SetApiKey, { apiKey });

export const testImmichConnection = (serverUrl: string, apiKey: string) =>
  invoke<ImmichConnectionInfo>(ImmichInvokes.TestConnection, { serverUrl, apiKey });

export const listImmichAlbums = () => invoke<ImmichAlbum[]>(ImmichInvokes.ListAlbums);

export const createImmichAlbum = (name: string) => invoke<ImmichAlbum>(ImmichInvokes.CreateAlbum, { name });

export const listImmichTimeline = () => invoke<ImmichTimelineMonth[]>(ImmichInvokes.Timeline);

export const monthFilter = (timeBucket: string): ImmichFilter => {
  const [year, month] = timeBucket.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  return { takenFrom: `${year}-${mm}-01`, takenUntil: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
};

const immichPaths = new Set<string>();

export const isImmichPath = (path: string) => immichPaths.has(path.split('?vc=')[0]);

export const getImmichAlbumImages = async (albumId: string) => {
  const images = await invoke<ImageFile[]>(ImmichInvokes.GetImages, { filter: albumIdToFilter(albumId) });
  images.forEach((image) => immichPaths.add(image.path.split('?vc=')[0]));
  return images;
};

export const immichMediaRefs = (paths: Array<string>) =>
  paths.some(isImmichPath)
    ? invoke<Array<ImmichMediaRef | null>>(ImmichInvokes.MediaRefs, { paths })
    : Promise.resolve(paths.map(() => null));

export const linkImmichMedia = (media: Array<{ path: string; immich: ImmichMediaRef }>) =>
  invoke<Array<ImmichOriginal | null>>(ImmichInvokes.LinkMedia, { media });

export const cancelImmichDownload = (path: string) => invoke<void>(ImmichInvokes.CancelDownload, { path });

export const getImmichSyncStatus = () => invoke<ImmichSyncStatus>(ImmichInvokes.SyncStatus);

export const flushImmichEdits = () => invoke<ImmichSyncStatus>(ImmichInvokes.Flush);

export const prepareImmichExport = (album: string, withOriginal: boolean) =>
  invoke<string>(ImmichInvokes.PrepareExport, { album, withOriginal });
