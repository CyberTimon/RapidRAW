import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from '../../../utils/leaflet-setup';
import 'leaflet.markercluster';

if ((L as any).DistanceGrid && (L as any).DistanceGrid.prototype) {
  const dgProto = (L as any).DistanceGrid.prototype;
  if (!dgProto.__rapidraw_patched) {
    dgProto.__rapidraw_patched = true;

    const origSqDist = dgProto._sqDist;
    dgProto._sqDist = function (p: any, p2: any) {
      if (!p || !p2 || typeof p.x !== 'number' || typeof p2.x !== 'number') {
        return Infinity;
      }
      return origSqDist.call(this, p, p2);
    };

    const origRemoveObject = dgProto.removeObject;
    dgProto.removeObject = function (obj: any, point: any) {
      const found = origRemoveObject.call(this, obj, point);
      if (!found) {
        const grid = this._grid;
        for (const r in grid) {
          const row = grid[r];
          if (!row) continue;
          for (const c in row) {
            const cell = row[c];
            if (!cell) continue;
            const idx = cell.indexOf(obj);
            if (idx !== -1) {
              cell.splice(idx, 1);
              if (cell.length === 0) {
                delete row[c];
              }
              return true;
            }
          }
        }
      }
      return found;
    };
  }
}
import { invoke } from '@tauri-apps/api/core';
import { List } from 'react-window';
import {
  Maximize2,
  Layers,
  Image as ImageIcon,
  MapPin,
  MapPinOff,
  PanelRightClose,
  PanelRightOpen,
  CheckCircle2,
  GripVertical,
  Undo2,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import debounce from 'lodash.debounce';
import { ImageFile, Invokes } from '../../ui/AppProperties';
import { useProcessStore } from '../../../store/useProcessStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useEditorStore } from '../../../store/useEditorStore';
import { getImageGps, getImageTimestamp, GeoLocation } from '../../../utils/gpsUtils';
import clsx from 'clsx';
import { IconAperture, IconFocalLength, IconIso, IconShutter } from '../editor/ExifIcons';

export type MapStyle = 'dark' | 'osm' | 'satellite';

interface MapLayerConfig {
  id: MapStyle;
  label: string;
  icon: string;
  url: string;
  attribution: string;
  className?: string;
  maxZoom: number;
}

const MAP_LAYERS: Record<MapStyle, MapLayerConfig> = {
  dark: {
    id: 'dark',
    label: 'Dark OSM',
    icon: '🌙',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: 'dark-map-tiles',
    maxZoom: 19,
  },
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    icon: '☀️',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: '',
    maxZoom: 19,
  },
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    icon: '🛰️',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and GIS User Community',
    className: '',
    maxZoom: 19,
  },
};

const MAP_STYLE_STORAGE_KEY = 'rapidraw_map_tile_style';
const MAP_SHOW_THUMBNAILS_STORAGE_KEY = 'rapidraw_map_show_thumbnails';
const MAP_DOCK_OPEN_STORAGE_KEY = 'rapidraw_map_dock_open';
const MAP_DOCK_WIDTH_STORAGE_KEY = 'rapidraw_map_dock_width';

function getInitialMapStyle(): MapStyle {
  try {
    const saved = localStorage.getItem(MAP_STYLE_STORAGE_KEY);
    if (saved && (saved === 'dark' || saved === 'osm' || saved === 'satellite')) {
      return saved as MapStyle;
    }
  } catch (e) {
    console.error('Failed to read map style from localStorage', e);
  }
  return 'dark';
}

function getInitialShowThumbnails(): boolean {
  try {
    const saved = localStorage.getItem(MAP_SHOW_THUMBNAILS_STORAGE_KEY);
    if (saved !== null) {
      return saved === 'true';
    }
  } catch (e) {
    console.error('Failed to read show thumbnails setting from localStorage', e);
  }
  return true;
}

function getInitialDockOpen(): boolean {
  try {
    const saved = localStorage.getItem(MAP_DOCK_OPEN_STORAGE_KEY);
    if (saved !== null) {
      return saved === 'true';
    }
  } catch (e) {
    console.error('Failed to read dock open setting from localStorage', e);
  }
  return true;
}

function getInitialDockWidth(): number {
  try {
    const saved = localStorage.getItem(MAP_DOCK_WIDTH_STORAGE_KEY);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 160 && parsed <= 550) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to read dock width setting from localStorage', e);
  }
  return 260;
}

function toDmsString(val: number): string {
  const absVal = Math.abs(val);
  const deg = Math.floor(absVal);
  const minFull = (absVal - deg) * 60;
  const min = Math.floor(minFull);
  const sec = (minFull - min) * 60;
  return `${deg} deg ${min} min ${sec.toFixed(4)} sec`;
}

interface MapPhotoItem {
  id: string;
  path: string;
  filename: string;
  lat: number;
  lon: number;
  timestamp: string | null;
  isRaw: boolean;
  image: ImageFile;
  hasNativeGps: boolean;
  isGpsModified: boolean;
}

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop()!.toUpperCase() : '';
}

function createCustomPin(isSelected: boolean, isRaw: boolean, photoPath?: string): L.DivIcon {
  const primaryColor = isSelected ? '#38bdf8' : isRaw ? '#f59e0b' : '#0284c7';
  const glow = isSelected ? 'filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.9));' : '';
  const encPath = photoPath ? encodeURIComponent(photoPath) : '';

  const html = `
    <div data-map-pin="photo" data-photo-path="${encPath}" style="${glow} width: 28px; height: 36px; display: inline-block; cursor: grab;">
      <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="pointer-events: none;">
        <path d="M14 0C6.268 0 0 6.268 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.268 21.732 0 14 0Z" fill="${primaryColor}"/>
        <circle cx="14" cy="14" r="11" fill="#0f172a"/>
        <circle cx="14" cy="14" r="5" fill="${primaryColor}"/>
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-photo-pin',
    iconSize: [28, 36],
    iconAnchor: [14, 36],
  });
}

function createThumbnailLoadingPin(
  isSelected: boolean,
  isRaw: boolean,
  _filename: string,
  photoPath?: string,
): L.DivIcon {
  const borderColor = isSelected ? '#38bdf8' : isRaw ? '#f59e0b' : '#0284c7';
  const glow = isSelected
    ? 'box-shadow: 0 0 16px rgba(56, 189, 248, 0.9), 0 4px 10px rgba(0, 0, 0, 0.6);'
    : 'box-shadow: 0 4px 10px rgba(0, 0, 0, 0.6);';
  const encPath = photoPath ? encodeURIComponent(photoPath) : '';

  const html = `
    <div data-map-pin="photo" data-photo-path="${encPath}" style="position: relative; cursor: grab; display: flex; flex-direction: column; align-items: center; ${isSelected ? 'z-index: 100000 !important;' : ''}">
      <div data-front-card="true" style="
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: ${isSelected ? '3px' : '2px'} solid ${borderColor};
        overflow: hidden;
        background-color: #0f172a;
        ${glow}
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        cursor: grab;
      ">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${borderColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.6; pointer-events: none;">
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
          <circle cx="9" cy="9" r="2"/>
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
        </svg>
      </div>
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid ${borderColor};
        margin-top: -1px;
        pointer-events: none;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-thumbnail-pin-loading',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
  });
}

function createPhotoThumbnailPin(
  thumbnailUrl: string,
  isSelected: boolean,
  isRaw: boolean,
  filename: string,
  photoPath?: string,
): L.DivIcon {
  const borderColor = isSelected ? '#38bdf8' : isRaw ? '#f59e0b' : '#0284c7';
  const glow = isSelected
    ? 'box-shadow: 0 0 16px rgba(56, 189, 248, 0.9), 0 4px 10px rgba(0, 0, 0, 0.6);'
    : 'box-shadow: 0 4px 10px rgba(0, 0, 0, 0.6);';
  const encPath = photoPath ? encodeURIComponent(photoPath) : '';

  const html = `
    <div data-map-pin="photo" data-photo-path="${encPath}" style="position: relative; cursor: grab; display: flex; flex-direction: column; align-items: center; ${isSelected ? 'z-index: 100000 !important;' : ''}">
      <div data-front-card="true" style="
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: ${isSelected ? '3px' : '2px'} solid ${borderColor};
        overflow: hidden;
        background-color: #0b0f19;
        ${glow}
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        cursor: grab;
      ">
        <img
          src="${thumbnailUrl}"
          alt="${filename}"
          draggable="false"
          style="width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; -webkit-user-drag: none; user-select: none;"
          loading="eager"
        />
      </div>
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid ${borderColor};
        margin-top: -1px;
        pointer-events: none;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-thumbnail-pin',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
  });
}

function createClusterThumbnailPin(
  thumbnailUrl: string,
  count: number,
  clusterId?: number,
  activeIndex?: number,
  isSelected: boolean = false,
): L.DivIcon {
  const countLabel =
    activeIndex !== undefined ? `${activeIndex + 1}/${count}` : count > 999 ? '999+' : count.toString();

  const borderColor = isSelected ? '#38bdf8' : '#0284c7';
  const glow = isSelected
    ? 'box-shadow: 0 0 18px rgba(56, 189, 248, 0.9), 0 8px 16px rgba(0, 0, 0, 0.7);'
    : 'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);';

  const html = `
    <div data-map-pin="cluster" data-cluster-id="${clusterId ?? ''}" style="position: relative; cursor: grab; display: flex; flex-direction: column; align-items: center; ${isSelected ? 'z-index: 100000 !important;' : ''}">
      <div data-stack-card="2" style="
        position: absolute;
        width: 90px;
        height: 90px;
        top: -4px;
        left: 5px;
        border-radius: 12px;
        background: #0f172a;
        border: 2px solid rgba(56, 189, 248, 0.35);
        transform: rotate(4deg);
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.5);
        cursor: pointer;
      "></div>
      <div data-stack-card="1" style="
        position: absolute;
        width: 93px;
        height: 93px;
        top: -2px;
        left: 1px;
        border-radius: 12px;
        background: #1e293b;
        border: 2px solid rgba(56, 189, 248, 0.6);
        transform: rotate(-3deg);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
        cursor: pointer;
      "></div>
      <div data-front-card="true" style="
        position: relative;
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: ${isSelected ? '3px' : '2px'} solid ${borderColor};
        overflow: hidden;
        background-color: #0b0f19;
        ${glow}
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
      ">
        <img
          src="${thumbnailUrl}"
          alt="Cluster"
          draggable="false"
          style="width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; -webkit-user-drag: none; user-select: none;"
          loading="eager"
        />
        <div style="
          position: absolute;
          top: 4px;
          right: 4px;
          background: #0284c7;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          padding: 2px 6px;
          border-radius: 9999px;
          border: 1.5px solid #38bdf8;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
          display: flex;
          align-items: center;
          gap: 3px;
          z-index: 10;
          pointer-events: none;
          user-select: none;
        ">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9; pointer-events: none;">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
          <span data-cluster-badge>${countLabel}</span>
        </div>
      </div>
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid ${borderColor};
        margin-top: -1px;
        pointer-events: none;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-cluster-thumbnail-pin',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
  });
}

function createClusterLoadingPin(
  count: number,
  clusterId?: number,
  activeIndex?: number,
  isSelected: boolean = false,
): L.DivIcon {
  const countLabel =
    activeIndex !== undefined ? `${activeIndex + 1}/${count}` : count > 999 ? '999+' : count.toString();

  const borderColor = isSelected ? '#38bdf8' : '#0284c7';
  const glow = isSelected
    ? 'box-shadow: 0 0 18px rgba(56, 189, 248, 0.9), 0 8px 16px rgba(0, 0, 0, 0.7);'
    : 'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);';
  const scale = isSelected ? 'scale(1.1)' : 'scale(1)';

  const html = `
    <div data-map-pin="cluster" data-cluster-id="${clusterId ?? ''}" style="position: relative; cursor: grab; display: flex; flex-direction: column; align-items: center; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); transform-origin: 50% 100%; transform: ${scale};">
      <div data-stack-card="2" style="
        position: absolute;
        width: 90px;
        height: 90px;
        top: -4px;
        left: 5px;
        border-radius: 12px;
        background: #0f172a;
        border: 2px solid rgba(56, 189, 248, 0.35);
        transform: rotate(4deg);
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.5);
        cursor: pointer;
      "></div>
      <div data-stack-card="1" style="
        position: absolute;
        width: 93px;
        height: 93px;
        top: -2px;
        left: 1px;
        border-radius: 12px;
        background: #1e293b;
        border: 2px solid rgba(56, 189, 248, 0.6);
        transform: rotate(-3deg);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
        cursor: pointer;
      "></div>
      <div data-front-card="true" style="
        position: relative;
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: ${isSelected ? '3px' : '2px'} solid ${borderColor};
        overflow: hidden;
        background-color: #0f172a;
        ${glow}
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
      ">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="${borderColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.6; pointer-events: none;">
          <polygon points="12 2 2 7 12 12 22 7 12 2"/>
          <polyline points="2 17 12 22 22 17"/>
          <polyline points="2 12 12 17 22 12"/>
        </svg>
        <div style="
          position: absolute;
          top: 4px;
          right: 4px;
          background: #0284c7;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          padding: 2px 6px;
          border-radius: 9999px;
          border: 1.5px solid #38bdf8;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
          display: flex;
          align-items: center;
          gap: 3px;
          z-index: 10;
          pointer-events: none;
          user-select: none;
        ">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9; pointer-events: none;">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
          <span data-cluster-badge>${countLabel}</span>
        </div>
      </div>
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid ${borderColor};
        margin-top: -1px;
        pointer-events: none;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-cluster-thumbnail-pin-loading',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
  });
}

function createCompactClusterPin(count: number, clusterId?: number): L.DivIcon {
  const countLabel = count > 999 ? '999+' : count.toString();
  const c = count < 10 ? 'small' : count < 100 ? 'medium' : 'large';
  return L.divIcon({
    html: `<div data-map-pin="cluster" data-cluster-id="${clusterId ?? ''}"><span>${countLabel}</span></div>`,
    className: `marker-cluster marker-cluster-${c}`,
    iconSize: new L.Point(40, 40),
  });
}

function getBestThumbnail(path: string): string | undefined {
  const proc = useProcessStore.getState();
  return proc.mediumThumbnails[path] || proc.thumbnails[path] || undefined;
}

interface PhotoClusterLayerProps {
  photos: MapPhotoItem[];
  selectedPath: string | null;
  multiSelectedPaths: string[];
  currentFolderPath?: string | null;
  onSelectPhoto: (path: string, event: MouseEvent) => void;
  onDoubleClickPhoto: (path: string) => void;
  onContextMenuPhoto: (event: MouseEvent, path: string) => void;
  onRevertGps?: (path: string) => void;
  onMovePhoto?: (paths: string[] | string, lat: number, lon: number) => void;
  onMapContextMenu?: (lat: number, lon: number, screenX: number, screenY: number) => void;
  showThumbnailCards: boolean;
  onRequestThumbnails?: (paths: string[]) => void;
  repositioningPath?: string | null;
  onStartReposition?: (path: string) => void;
  onRepositionSelect?: (lat: number, lon: number) => void;
}

const PhotoClusterLayer: React.FC<PhotoClusterLayerProps> = ({
  photos,
  selectedPath,
  multiSelectedPaths,
  currentFolderPath,
  onSelectPhoto,
  onDoubleClickPhoto,
  onContextMenuPhoto,
  onRevertGps,
  onMovePhoto,
  onMapContextMenu,
  showThumbnailCards,
  onRequestThumbnails,
  repositioningPath,
  onStartReposition,
  onRepositionSelect,
}) => {
  const map = useMap();
  const [cluster, setCluster] = useState<L.MarkerClusterGroup | null>(null);
  const markersMapRef = useRef<Map<string, L.Marker>>(new Map());
  const clustersMapRef = useRef<Map<number, L.MarkerCluster>>(new Map());
  const isWheelSelectingRef = useRef<boolean>(false);
  const hasInitialFitRef = useRef<boolean>(false);
  const prevSelectedPathRef = useRef<string | null>(null);
  const prevSelectedPathsRef = useRef<Set<string>>(new Set(multiSelectedPaths || []));
  const hasZoomedToInitialRef = useRef<boolean>(false);
  const ignoreNextClusterClickRef = useRef<boolean>(false);
  const prevThumbnailsMapRef = useRef<Map<string, string>>(new Map());
  const thumbnails = useProcessStore((s) => s.thumbnails);
  const mediumThumbnails = useProcessStore((s) => s.mediumThumbnails);
  const { t } = useTranslation();

  const selectedPathsSet = useMemo(() => new Set(multiSelectedPaths || []), [multiSelectedPaths]);
  const selectedPathsSetRef = useRef<Set<string>>(selectedPathsSet);
  useEffect(() => {
    selectedPathsSetRef.current = selectedPathsSet;
  }, [selectedPathsSet]);

  const multiSelectedPathsRef = useRef<string[]>(multiSelectedPaths || []);
  useEffect(() => {
    multiSelectedPathsRef.current = multiSelectedPaths || [];
  }, [multiSelectedPaths]);

  const prevElevatedMarkerRef = useRef<L.Marker | null>(null);
  const elevateMarker = useCallback((targetMarker: L.Marker | null) => {
    if (prevElevatedMarkerRef.current && prevElevatedMarkerRef.current !== targetMarker) {
      try {
        if (typeof (prevElevatedMarkerRef.current as any).setZIndexOffset === 'function') {
          prevElevatedMarkerRef.current.setZIndexOffset(0);
        }
        const prevEl = prevElevatedMarkerRef.current.getElement
          ? prevElevatedMarkerRef.current.getElement()
          : (prevElevatedMarkerRef.current as any)._icon;
        if (prevEl) {
          prevEl.style.zIndex = '';
          prevEl.classList.remove('elevated-map-marker');
        }
      } catch {}
    }
    prevElevatedMarkerRef.current = targetMarker;
    if (targetMarker) {
      try {
        if (typeof (targetMarker as any).setZIndexOffset === 'function') {
          targetMarker.setZIndexOffset(100000);
        }
        const el = targetMarker.getElement ? targetMarker.getElement() : (targetMarker as any)._icon;
        if (el) {
          el.style.zIndex = '100000';
          el.classList.add('elevated-map-marker');
        }
      } catch {}
    }
  }, []);

  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  const pendingRefreshMarkersRef = useRef<L.Marker[]>([]);
  const refreshRafRef = useRef<number | null>(null);

  const selectedPathRef = useRef<string | null>(selectedPath);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const onRequestThumbnailsRef = useRef(onRequestThumbnails);
  useEffect(() => {
    onRequestThumbnailsRef.current = onRequestThumbnails;
  }, [onRequestThumbnails]);

  const onSelectPhotoRef = useRef(onSelectPhoto);
  useEffect(() => {
    onSelectPhotoRef.current = onSelectPhoto;
  }, [onSelectPhoto]);

  const onDoubleClickPhotoRef = useRef(onDoubleClickPhoto);
  useEffect(() => {
    onDoubleClickPhotoRef.current = onDoubleClickPhoto;
  }, [onDoubleClickPhoto]);

  const showThumbnailCardsRef = useRef<boolean>(showThumbnailCards);
  useEffect(() => {
    showThumbnailCardsRef.current = showThumbnailCards;
  }, [showThumbnailCards]);

  useEffect(() => {
    hasInitialFitRef.current = false;
    hasZoomedToInitialRef.current = false;
  }, [currentFolderPath]);

  const onMovePhotoRef = useRef(onMovePhoto);
  useEffect(() => {
    onMovePhotoRef.current = onMovePhoto;
  }, [onMovePhoto]);

  const onStartRepositionRef = useRef(onStartReposition);
  useEffect(() => {
    onStartRepositionRef.current = onStartReposition;
  }, [onStartReposition]);

  const onRepositionSelectRef = useRef(onRepositionSelect);
  useEffect(() => {
    onRepositionSelectRef.current = onRepositionSelect;
  }, [onRepositionSelect]);

  const repositioningPathRef = useRef(repositioningPath);
  useEffect(() => {
    repositioningPathRef.current = repositioningPath;
  }, [repositioningPath]);

  const onContextMenuPhotoRef = useRef(onContextMenuPhoto);
  useEffect(() => {
    onContextMenuPhotoRef.current = onContextMenuPhoto;
  }, [onContextMenuPhoto]);

  useEffect(() => {
    const container = map.getContainer();
    if (repositioningPath) {
      container.style.cursor = 'crosshair';
    } else {
      container.style.cursor = '';
    }
    return () => {
      container.style.cursor = '';
    };
  }, [map, repositioningPath]);

  useEffect(() => {
    const container = map.getContainer();

    const getPinTargetPhotoPath = (pinEl: HTMLElement): string | null => {
      const pinType = pinEl.getAttribute('data-map-pin');
      if (pinType === 'photo') {
        const raw = pinEl.getAttribute('data-photo-path');
        return raw ? decodeURIComponent(raw) : null;
      }
      if (pinType === 'cluster') {
        const clusterIdStr = pinEl.getAttribute('data-cluster-id');
        const clusterId = clusterIdStr ? Number(clusterIdStr) : null;
        const clusterMarker = clusterId !== null ? clustersMapRef.current.get(clusterId) : null;
        if (clusterMarker) {
          const childMarkers = clusterMarker.getAllChildMarkers();
          const childPhotos = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);
          let activeIdx = (clusterMarker as any)._activePhotoIndex ?? 0;
          if (activeIdx < 0 || activeIdx >= childPhotos.length) activeIdx = 0;
          return childPhotos[activeIdx] || childPhotos[0] || null;
        }
      }
      return null;
    };

    const handleWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      const clusterEl = target?.closest('[data-map-pin="cluster"]') as HTMLElement | null;
      if (!clusterEl) return;

      const clusterIdStr = clusterEl.getAttribute('data-cluster-id');
      if (!clusterIdStr) return;

      const clusterId = Number(clusterIdStr);
      const clusterMarker = clustersMapRef.current.get(clusterId);
      if (!clusterMarker) return;

      const childMarkers = clusterMarker.getAllChildMarkers();
      if (!childMarkers || childMarkers.length <= 1) return;

      const childPhotos: string[] = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);

      if (childPhotos.length <= 1) return;

      e.preventDefault();
      e.stopPropagation();

      elevateMarker(clusterMarker);

      let currentIdx = (clusterMarker as any)._activePhotoIndex ?? -1;
      if (currentIdx === -1 && selectedPathRef.current) {
        currentIdx = childPhotos.indexOf(selectedPathRef.current);
      }
      if (currentIdx === -1) {
        currentIdx = 0;
      }

      const direction = e.deltaY < 0 ? 1 : -1;
      const nextIdx = (currentIdx + direction + childPhotos.length) % childPhotos.length;
      (clusterMarker as any)._activePhotoIndex = nextIdx;
      const nextPath = childPhotos[nextIdx];

      if (onRequestThumbnailsRef.current) {
        onRequestThumbnailsRef.current([nextPath]);
      }

      const imgEl = clusterEl.querySelector('img');
      const thumb = getBestThumbnail(nextPath);
      if (imgEl) {
        imgEl.src = thumb || '';
      }
      const badgeEl = clusterEl.querySelector('[data-cluster-badge]');
      if (badgeEl) {
        badgeEl.textContent = `${nextIdx + 1}/${childPhotos.length}`;
      }

      isWheelSelectingRef.current = true;
      useLibraryStore.getState().setLibrary({
        multiSelectedPaths: [nextPath],
        libraryActivePath: nextPath,
        selectionAnchorPath: nextPath,
      });
      const photoObj = useLibraryStore.getState().imageList.find((p) => p.path === nextPath);
      if (photoObj) {
        useEditorStore.getState().setEditor({ selectedImage: photoObj });
      }
      onSelectPhotoRef.current(nextPath, new MouseEvent('click'));
      setTimeout(() => {
        isWheelSelectingRef.current = false;
      }, 150);
    };

    const handlePinMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const pinEl = target?.closest('[data-map-pin]') as HTMLElement | null;
      if (!pinEl) return;

      const pinType = pinEl.getAttribute('data-map-pin');

      map.dragging.disable();

      const stackCard = target?.closest('[data-stack-card]') as HTMLElement | null;
      if (pinType === 'cluster' && stackCard) {
        e.preventDefault();
        e.stopPropagation();
        ignoreNextClusterClickRef.current = true;

        const clusterIdStr = pinEl.getAttribute('data-cluster-id');
        const clusterId = clusterIdStr ? Number(clusterIdStr) : null;
        const clusterMarker = clusterId !== null ? clustersMapRef.current.get(clusterId) : null;
        if (clusterMarker) {
          const childMarkers = clusterMarker.getAllChildMarkers();
          const childPhotos: string[] = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);

          if (childPhotos.length > 1) {
            const stackNum = Number(stackCard.getAttribute('data-stack-card') || '1');
            let currentIdx = (clusterMarker as any)._activePhotoIndex ?? 0;
            const nextIdx = (currentIdx + stackNum) % childPhotos.length;
            (clusterMarker as any)._activePhotoIndex = nextIdx;
            const nextPath = childPhotos[nextIdx];

            if (onRequestThumbnailsRef.current) {
              onRequestThumbnailsRef.current([nextPath]);
            }

            const imgEl = pinEl.querySelector('img');
            const thumb = getBestThumbnail(nextPath);
            if (imgEl) {
              imgEl.src = thumb || '';
            }
            const badgeEl = pinEl.querySelector('[data-cluster-badge]');
            if (badgeEl) {
              badgeEl.textContent = `${nextIdx + 1}/${childPhotos.length}`;
            }

            useLibraryStore.getState().setLibrary({
              multiSelectedPaths: [nextPath],
              libraryActivePath: nextPath,
              selectionAnchorPath: nextPath,
            });
            const photoObj = useLibraryStore.getState().imageList.find((p) => p.path === nextPath);
            if (photoObj) {
              useEditorStore.getState().setEditor({ selectedImage: photoObj });
            }
            onSelectPhotoRef.current(nextPath, new MouseEvent('click'));
          }
        }

        const onStackMouseUp = () => {
          window.removeEventListener('mouseup', onStackMouseUp, true);
          map.dragging.enable();
        };
        window.addEventListener('mouseup', onStackMouseUp, true);
        return;
      }

      const targetPhotoPath = getPinTargetPhotoPath(pinEl);
      if (!targetPhotoPath) {
        map.dragging.enable();
        return;
      }

      const photoToDrag = targetPhotoPath;
      const isPhotoSelected = selectedPathsSetRef.current.has(photoToDrag);
      const currentMulti = multiSelectedPathsRef.current;
      const pathsToMove = isPhotoSelected && currentMulti.length > 1 ? currentMulti : [photoToDrag];

      const cardEl = (pinEl.querySelector('[data-front-card="true"]') || pinEl.firstElementChild) as HTMLElement | null;
      const cardRect = cardEl ? cardEl.getBoundingClientRect() : pinEl.getBoundingClientRect();
      const grabOffsetX = e.clientX - cardRect.left;
      const grabOffsetY = e.clientY - cardRect.top;

      const isThumbnailMode = showThumbnailCardsRef.current;
      const pinWidth = isThumbnailMode ? 96 : 28;
      const pinHeight = isThumbnailMode ? 106 : 36;
      const anchorX = isThumbnailMode ? 48 : 14;
      const anchorY = isThumbnailMode ? 106 : 36;

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let avatarEl: HTMLDivElement | null = null;

      const onMouseMove = (moveEv: MouseEvent) => {
        const dx = moveEv.clientX - startX;
        const dy = moveEv.clientY - startY;
        if (!isDragging && Math.hypot(dx, dy) > 4) {
          isDragging = true;
          pinEl.style.opacity = '0.4';

          avatarEl = document.createElement('div');
          avatarEl.className = 'photo-drag-avatar';
          avatarEl.style.cssText = `
            position: fixed;
            left: ${moveEv.clientX - grabOffsetX}px;
            top: ${moveEv.clientY - grabOffsetY}px;
            width: ${pinWidth}px;
            height: ${pinHeight}px;
            pointer-events: none;
            z-index: 9999999;
            filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.7));
          `;

          const activeThumb = getBestThumbnail(photoToDrag);
          const countBadge =
            pathsToMove.length > 1
              ? `
            <div style="
              position: absolute;
              top: 4px;
              right: 4px;
              background: #0284c7;
              color: #ffffff;
              font-size: 11px;
              font-weight: 800;
              font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
              padding: 2px 6px;
              border-radius: 9999px;
              border: 1.5px solid #38bdf8;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
              display: flex;
              align-items: center;
              gap: 3px;
              z-index: 10;
              pointer-events: none;
              user-select: none;
            ">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                <polyline points="2 17 12 22 22 17"/>
                <polyline points="2 12 12 17 22 12"/>
              </svg>
              <span>${pathsToMove.length}</span>
            </div>
            `
              : '';

          if (isThumbnailMode) {
            avatarEl.innerHTML = `
              <div style="
                width: 96px;
                height: 96px;
                border-radius: 12px;
                border: 3px solid #38bdf8;
                overflow: hidden;
                background-color: #0b0f19;
                box-shadow: 0 0 20px rgba(56, 189, 248, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
              ">
                ${
                  activeThumb
                    ? `<img src="${activeThumb}" style="width: 100%; height: 100%; object-fit: cover; display: block;" draggable="false" />`
                    : `<div style="color: #38bdf8; font-size: 11px; font-weight: 600;">${
                        pathsToMove.length > 1 ? `Moving ${pathsToMove.length}...` : 'Moving...'
                      }</div>`
                }
                ${countBadge}
              </div>
              <div style="
                width: 0;
                height: 0;
                border-left: 9px solid transparent;
                border-right: 9px solid transparent;
                border-top: 10px solid #38bdf8;
                margin-left: auto;
                margin-right: auto;
                margin-top: -1px;
              "></div>
            `;
          } else {
            avatarEl.innerHTML = `
              <div style="filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.9)); width: 28px; height: 36px; display: inline-block;">
                <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 0C6.268 0 0 6.268 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.268 21.732 0 14 0Z" fill="#38bdf8"/>
                  <circle cx="14" cy="14" r="11" fill="#0f172a"/>
                  <circle cx="14" cy="14" r="5" fill="#38bdf8"/>
                </svg>
              </div>
            `;
          }
          document.body.appendChild(avatarEl);
        }

        if (isDragging && avatarEl) {
          avatarEl.style.left = `${moveEv.clientX - grabOffsetX}px`;
          avatarEl.style.top = `${moveEv.clientY - grabOffsetY}px`;
        }
      };

      const onMouseUp = (upEv: MouseEvent) => {
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('mouseup', onMouseUp, true);

        map.dragging.enable();
        pinEl.style.opacity = '1';

        if (avatarEl && avatarEl.parentNode) {
          avatarEl.parentNode.removeChild(avatarEl);
          avatarEl = null;
        }

        if (isDragging) {
          upEv.preventDefault();
          upEv.stopPropagation();
          ignoreNextClusterClickRef.current = true;

          const avatarLeft = upEv.clientX - grabOffsetX;
          const avatarTop = upEv.clientY - grabOffsetY;
          const triangleTipX = avatarLeft + anchorX;
          const triangleTipY = avatarTop + anchorY;

          const mapContainer = map.getContainer();
          const rect = mapContainer.getBoundingClientRect();
          const pt = L.point(triangleTipX - rect.left, triangleTipY - rect.top);
          const dropLatLng = map.containerPointToLatLng(pt);
          const lat = dropLatLng.lat;
          const lon = ((((dropLatLng.lng + 180) % 360) + 360) % 360) - 180;

          useLibraryStore.getState().setLibrary({
            multiSelectedPaths: pathsToMove,
            libraryActivePath: photoToDrag,
            selectionAnchorPath: photoToDrag,
          });
          const photoObj = useLibraryStore.getState().imageList.find((p) => p.path === photoToDrag);
          if (photoObj) {
            useEditorStore.getState().setEditor({ selectedImage: photoObj });
          }

          if (onMovePhotoRef.current) {
            onMovePhotoRef.current(pathsToMove, lat, lon);
          }
        } else {
          onSelectPhotoRef.current(photoToDrag, upEv);
        }
      };

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
    };

    const handlePinDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const pinEl = target?.closest('[data-map-pin]') as HTMLElement | null;
      if (!pinEl) return;

      e.preventDefault();
      e.stopPropagation();

      const targetPhotoPath = getPinTargetPhotoPath(pinEl);
      if (targetPhotoPath && onDoubleClickPhotoRef.current) {
        onDoubleClickPhotoRef.current(targetPhotoPath);
      }
    };

    const handlePinContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const pinEl = target?.closest('[data-map-pin]') as HTMLElement | null;
      if (!pinEl) return;

      e.preventDefault();
      e.stopPropagation();

      const targetPhotoPath = getPinTargetPhotoPath(pinEl);
      if (targetPhotoPath && onContextMenuPhotoRef.current) {
        onContextMenuPhotoRef.current(e, targetPhotoPath);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    container.addEventListener('mousedown', handlePinMouseDown, { capture: true });
    container.addEventListener('dblclick', handlePinDblClick, { capture: true });
    container.addEventListener('contextmenu', handlePinContextMenu, { capture: true });
    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true } as any);
      container.removeEventListener('mousedown', handlePinMouseDown, { capture: true } as any);
      container.removeEventListener('dblclick', handlePinDblClick, { capture: true } as any);
      container.removeEventListener('contextmenu', handlePinContextMenu, { capture: true } as any);
    };
  }, [map, elevateMarker]);

  useEffect(() => {
    const handleContextMenu = (e: L.LeafletMouseEvent) => {
      if (onMapContextMenuRef.current) {
        onMapContextMenuRef.current(
          e.latlng.lat,
          ((((e.latlng.lng + 180) % 360) + 360) % 360) - 180,
          e.originalEvent.clientX,
          e.originalEvent.clientY,
        );
      }
    };

    const handleMapClick = (e: L.LeafletMouseEvent) => {
      if (repositioningPathRef.current && onRepositionSelectRef.current) {
        onRepositionSelectRef.current(e.latlng.lat, ((((e.latlng.lng + 180) % 360) + 360) % 360) - 180);
      }
    };

    map.on('contextmenu', handleContextMenu);
    map.on('click', handleMapClick);
    return () => {
      map.off('contextmenu', handleContextMenu);
      map.off('click', handleMapClick);
    };
  }, [map]);

  useEffect(() => {
    const clusterGroup = L.markerClusterGroup({
      chunkedLoading: false,
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: false,
      animate: false,
      animateAddingMarkers: false,
      disableClusteringAtZoom: 18,
      iconCreateFunction: (c: L.MarkerCluster) => {
        const count = c.getChildCount();
        const clusterId = (c as any)._leaflet_id;
        clustersMapRef.current.set(clusterId, c);

        const childMarkers = c.getAllChildMarkers();
        const childPaths = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);

        let activeIdx = (c as any)._activePhotoIndex;
        if (activeIdx === undefined || activeIdx >= childPaths.length || activeIdx < 0) {
          let foundIdx = -1;
          if (selectedPathRef.current) {
            foundIdx = childPaths.indexOf(selectedPathRef.current);
          }
          if (foundIdx === -1) {
            foundIdx = childPaths.findIndex((p) => selectedPathsSetRef.current.has(p));
          }
          activeIdx = foundIdx !== -1 ? foundIdx : 0;
          (c as any)._activePhotoIndex = activeIdx;
        }

        const activePath = childPaths[activeIdx] || childPaths[0];

        if (!showThumbnailCardsRef.current) {
          return createCompactClusterPin(count, clusterId);
        }

        let cachedThumbUrl: string | null = (activePath && getBestThumbnail(activePath)) || null;
        if (!cachedThumbUrl) {
          for (let i = 0; i < childPaths.length; i++) {
            const p = childPaths[i];
            const found = p && getBestThumbnail(p);
            if (found) {
              cachedThumbUrl = found;
              break;
            }
          }
        }

        const isSelected = childPaths.some((p) => selectedPathsSetRef.current.has(p));

        if (cachedThumbUrl) {
          return createClusterThumbnailPin(cachedThumbUrl, count, clusterId, activeIdx, isSelected);
        }

        return createClusterLoadingPin(count, clusterId, activeIdx, isSelected);
      },
    });

    const handleClusterClick = (e: L.LeafletEvent) => {
      if (ignoreNextClusterClickRef.current) {
        ignoreNextClusterClickRef.current = false;
        return;
      }
      const clusterMarker = (e as any).layer as L.MarkerCluster;
      if (!clusterMarker) return;

      elevateMarker(clusterMarker);

      const childMarkers = clusterMarker.getAllChildMarkers();
      const childPaths = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);
      if (childPaths.length === 0) return;

      let activeIdx = (clusterMarker as any)._activePhotoIndex ?? 0;
      if (activeIdx < 0 || activeIdx >= childPaths.length) activeIdx = 0;
      const activePath = childPaths[activeIdx] || childPaths[0];

      const photoObj = useLibraryStore.getState().imageList.find((p) => p.path === activePath);
      if (photoObj) {
        useEditorStore.getState().setEditor({ selectedImage: photoObj });
      }

      onSelectPhotoRef.current(activePath, (e as any).originalEvent || new MouseEvent('click'));
    };

    clusterGroup.on('clusterclick', handleClusterClick);

    map.addLayer(clusterGroup);
    setCluster(clusterGroup);

    return () => {
      if (refreshRafRef.current !== null) {
        cancelAnimationFrame(refreshRafRef.current);
        refreshRafRef.current = null;
      }
      clusterGroup.off('clusterclick', handleClusterClick);
      clusterGroup.clearLayers();
      map.removeLayer(clusterGroup);
      clustersMapRef.current.clear();
      markersMapRef.current.clear();
      setCluster(null);
    };
  }, [map, elevateMarker]);

  const requestVisibleThumbnails = useCallback(() => {
    if (!showThumbnailCards || !onRequestThumbnails || !map || !cluster) return;

    try {
      const bounds = map.getBounds();
      const hasThumb = (p: string) => Boolean(getBestThumbnail(p));
      const missing: string[] = [];
      const seenClusters = new Set<any>();

      for (const photo of photosRef.current) {
        if (missing.length >= 30) break;

        const marker = markersMapRef.current.get(photo.path);
        if (!marker) continue;

        if (!bounds.contains([photo.lat, photo.lon])) continue;

        const visibleParent = cluster.getVisibleParent(marker);
        if (!visibleParent) continue;

        if (visibleParent === marker) {
          if (!hasThumb(photo.path) && !missing.includes(photo.path)) {
            missing.push(photo.path);
          }
        } else {
          if (seenClusters.has(visibleParent)) continue;
          seenClusters.add(visibleParent);

          const childMarkers = (visibleParent as L.MarkerCluster).getAllChildMarkers();
          const hasAnyCachedThumb = childMarkers.some((m) => {
            const p = (m as any).photoPath;
            return p && hasThumb(p);
          });

          if (!hasAnyCachedThumb && childMarkers.length > 0) {
            const repPath = (childMarkers[0] as any)?.photoPath;
            if (repPath && !hasThumb(repPath) && !missing.includes(repPath)) {
              missing.push(repPath);
            }
          }
        }
      }

      if (missing.length > 0) {
        onRequestThumbnails(missing);
      }
    } catch {}
  }, [showThumbnailCards, onRequestThumbnails, map, cluster]);

  useEffect(() => {
    if (!cluster) return;

    const currentPaths = new Set(photos.map((p) => p.path));
    const existingMarkers = markersMapRef.current;

    const markersToRemove: L.Marker[] = [];
    existingMarkers.forEach((marker, path) => {
      if (!currentPaths.has(path)) {
        markersToRemove.push(marker);
        existingMarkers.delete(path);
      }
    });
    if (markersToRemove.length > 0) {
      cluster.removeLayers(markersToRemove);
    }

    const markersToAdd: L.Marker[] = [];
    const markersToReposition: L.Marker[] = [];

    photos.forEach((photo) => {
      let marker = existingMarkers.get(photo.path);

      if (!marker) {
        const isSelected = selectedPathsSet.has(photo.path);
        const cachedThumb = getBestThumbnail(photo.path);

        const icon = !showThumbnailCards
          ? createCustomPin(isSelected, photo.isRaw, photo.path)
          : cachedThumb
            ? createPhotoThumbnailPin(cachedThumb, isSelected, photo.isRaw, photo.filename, photo.path)
            : createThumbnailLoadingPin(isSelected, photo.isRaw, photo.filename, photo.path);

        marker = L.marker([photo.lat, photo.lon], {
          icon,
          title: photo.filename,
          draggable: false,
          autoPan: false,
        });
        (marker as any).photoPath = photo.path;

        existingMarkers.set(photo.path, marker);
        markersToAdd.push(marker);
      } else {
        (marker as any).photoPath = photo.path;
        const curLatLng = marker.getLatLng();
        if (Math.abs(curLatLng.lat - photo.lat) > 1e-6 || Math.abs(curLatLng.lng - photo.lon) > 1e-6) {
          markersToReposition.push(marker);
        }
      }
    });

    if (markersToReposition.length > 0) {
      cluster.removeLayers(markersToReposition);
      for (const m of markersToReposition) {
        const p = photos.find((ph) => ph.path === (m as any).photoPath);
        if (p) {
          m.setLatLng([p.lat, p.lon]);
        }
      }
      cluster.addLayers(markersToReposition);
    }

    if (markersToAdd.length > 0) {
      cluster.addLayers(markersToAdd);
    }

    const selectedPhoto = selectedPath ? photos.find((p) => p.path === selectedPath) : null;

    if (!hasInitialFitRef.current && photos.length > 0) {
      hasInitialFitRef.current = true;
      if (selectedPhoto) {
        hasZoomedToInitialRef.current = true;
        const targetZoom = 16;
        map.setView([selectedPhoto.lat, selectedPhoto.lon], targetZoom);
      } else {
        hasZoomedToInitialRef.current = true;
        try {
          const latLngs = photos.map((p) => [p.lat, p.lon] as [number, number]);
          const bounds = L.latLngBounds(latLngs);
          if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
          }
        } catch (e) {
          console.error('Failed to fit bounds', e);
        }
      }
    }
  }, [
    cluster,
    photos,
    selectedPath,
    onSelectPhoto,
    onDoubleClickPhoto,
    onContextMenuPhoto,
    onRequestThumbnails,
    map,
    showThumbnailCards,
    elevateMarker,
  ]);

  useEffect(() => {
    if (!showThumbnailCards || !cluster) return;

    const debouncedReq = debounce(requestVisibleThumbnails, 250);
    map.on('moveend', debouncedReq);
    map.on('zoomend', debouncedReq);

    const timer = setTimeout(requestVisibleThumbnails, 400);

    return () => {
      map.off('moveend', debouncedReq);
      map.off('zoomend', debouncedReq);
      clearTimeout(timer);
      debouncedReq.cancel();
    };
  }, [map, cluster, showThumbnailCards, requestVisibleThumbnails]);

  useEffect(() => {
    const newlyAdded: string[] = [];
    const checkDict = (dict: Record<string, string>) => {
      for (const path in dict) {
        const url = dict[path];
        if (url && prevThumbnailsMapRef.current.get(path) !== url) {
          prevThumbnailsMapRef.current.set(path, url);
          newlyAdded.push(path);
        }
      }
    };
    checkDict(thumbnails);
    checkDict(mediumThumbnails);

    if (newlyAdded.length === 0) return;

    if (!showThumbnailCards) return;

    const markersToRefresh: L.Marker[] = [];
    for (const path of newlyAdded) {
      const marker = markersMapRef.current.get(path);
      const photo = photos.find((p) => p.path === path);
      if (marker && photo) {
        const thumbUrl = mediumThumbnails[path] || thumbnails[path];
        const isSelected = selectedPathsSetRef.current.has(path);
        marker.setIcon(createPhotoThumbnailPin(thumbUrl, isSelected, photo.isRaw, photo.filename, photo.path));
        markersToRefresh.push(marker);
      }
    }

    if (cluster && markersToRefresh.length > 0) {
      pendingRefreshMarkersRef.current.push(...markersToRefresh);
      if (refreshRafRef.current === null) {
        refreshRafRef.current = requestAnimationFrame(() => {
          refreshRafRef.current = null;
          const toRefresh = pendingRefreshMarkersRef.current;
          pendingRefreshMarkersRef.current = [];
          if (cluster && toRefresh.length > 0) {
            try {
              cluster.refreshClusters(toRefresh);
            } catch {}
          }
        });
      }
    }
  }, [thumbnails, mediumThumbnails, showThumbnailCards, photos, selectedPath, cluster]);

  useEffect(() => {
    markersMapRef.current.forEach((marker, path) => {
      const photo = photosRef.current.find((p) => p.path === path);
      if (!photo) return;

      const isSelected = selectedPathsSetRef.current.has(path);
      if (!showThumbnailCards) {
        marker.setIcon(createCustomPin(isSelected, photo.isRaw, photo.path));
      } else {
        const thumb = getBestThumbnail(path);
        marker.setIcon(
          thumb
            ? createPhotoThumbnailPin(thumb, isSelected, photo.isRaw, photo.filename, photo.path)
            : createThumbnailLoadingPin(isSelected, photo.isRaw, photo.filename, photo.path),
        );
      }
    });

    if (cluster) {
      cluster.refreshClusters();
    }
  }, [showThumbnailCards, cluster]);

  useEffect(() => {
    const currentSet = new Set(multiSelectedPaths || []);
    const prevSet = prevSelectedPathsRef.current;

    const deselected: string[] = [];
    prevSet.forEach((p) => {
      if (!currentSet.has(p)) {
        deselected.push(p);
      }
    });

    const newlySelected: string[] = [];
    currentSet.forEach((p) => {
      if (!prevSet.has(p)) {
        newlySelected.push(p);
      }
    });

    prevSelectedPathsRef.current = currentSet;

    for (const p of deselected) {
      const marker = markersMapRef.current.get(p);
      const photo = photos.find((ph) => ph.path === p);
      if (marker && photo) {
        const thumb = getBestThumbnail(p);
        marker.setIcon(
          !showThumbnailCards
            ? createCustomPin(false, photo.isRaw, photo.path)
            : thumb
              ? createPhotoThumbnailPin(thumb, false, photo.isRaw, photo.filename, photo.path)
              : createThumbnailLoadingPin(false, photo.isRaw, photo.filename, photo.path),
        );
      }
    }

    for (const p of newlySelected) {
      const marker = markersMapRef.current.get(p);
      const photo = photos.find((ph) => ph.path === p);
      if (marker && photo) {
        const thumb = getBestThumbnail(p);
        marker.setIcon(
          !showThumbnailCards
            ? createCustomPin(true, photo.isRaw, photo.path)
            : thumb
              ? createPhotoThumbnailPin(thumb, true, photo.isRaw, photo.filename, photo.path)
              : createThumbnailLoadingPin(true, photo.isRaw, photo.filename, photo.path),
        );
      }
    }

    if (cluster && (deselected.length > 0 || newlySelected.length > 0)) {
      try {
        cluster.refreshClusters();
      } catch {}
    }

    if (!selectedPath) {
      elevateMarker(null);
      return;
    }

    if (isWheelSelectingRef.current) return;

    const marker = markersMapRef.current.get(selectedPath);
    const photo = photos.find((p) => p.path === selectedPath);

    if (marker && photo) {
      const visibleParent = cluster ? cluster.getVisibleParent(marker) : marker;
      const targetToElevate = visibleParent || marker;

      const thumb = getBestThumbnail(selectedPath);
      marker.setIcon(
        showThumbnailCards && thumb
          ? createPhotoThumbnailPin(thumb, true, photo.isRaw, photo.filename, photo.path)
          : showThumbnailCards
            ? createThumbnailLoadingPin(true, photo.isRaw, photo.filename, photo.path)
            : createCustomPin(true, photo.isRaw, photo.path),
      );
      elevateMarker(targetToElevate);

      if (visibleParent && visibleParent !== marker) {
        const clusterObj = visibleParent as L.MarkerCluster;
        const childMarkers = clusterObj.getAllChildMarkers();
        const childPaths = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);
        const idx = childPaths.indexOf(photo.path);
        if (idx !== -1) {
          (clusterObj as any)._activePhotoIndex = idx;
          const el = clusterObj.getElement();
          if (el) {
            const imgEl = el.querySelector('img');
            if (imgEl && thumb) {
              imgEl.src = thumb;
            }
            const badgeEl = el.querySelector('[data-cluster-badge]');
            if (badgeEl) {
              badgeEl.textContent = `${idx + 1}/${childPaths.length}`;
            }
          }
        }
      }
    }
  }, [multiSelectedPaths, selectedPath, photos, map, showThumbnailCards, cluster, elevateMarker]);

  return null;
};

interface UnlocatedPhotoCardProps {
  photo: ImageFile;
  filename: string;
  timestamp: string | null;
  exif?: Record<string, string>;
  isSelected: boolean;
  cardHeight: number;
  onSelect: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onRequestThumb: (path: string) => void;
}

const UnlocatedPhotoCard: React.FC<UnlocatedPhotoCardProps> = React.memo(
  ({
    photo,
    filename,
    timestamp,
    exif,
    isSelected,
    cardHeight,
    onSelect,
    onDoubleClick,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onRequestThumb,
  }) => {
    const thumbUrl = useProcessStore((s) => s.mediumThumbnails[photo.path] || s.thumbnails[photo.path]);

    useEffect(() => {
      if (!thumbUrl) {
        onRequestThumb(photo.path);
      }
    }, [photo.path, thumbUrl, onRequestThumb]);

    const { shutter, fNumber, iso, focal } = useMemo(() => {
      const e = exif || photo.exif || {};
      let fNum = e.FNumber ? String(e.FNumber) : '';
      if (fNum && !fNum.toLowerCase().startsWith('f')) fNum = `f/${fNum}`;
      const focalVal = e.FocalLengthIn35mmFilm || e.FocalLength || '';
      const focalStr = focalVal ? (String(focalVal).endsWith('mm') ? String(focalVal) : `${focalVal}mm`) : '';
      return {
        shutter: e.ExposureTime || '',
        fNumber: fNum,
        iso: e.PhotographicSensitivity || e.ISOSpeedRatings || '',
        focal: focalStr,
      };
    }, [exif, photo.exif]);

    return (
      <div
        draggable={true}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        style={{ width: '100%', height: cardHeight }}
        className={clsx(
          'shrink-0 bg-surface rounded-md overflow-hidden cursor-pointer active:cursor-grabbing group relative flex flex-col transition-shadow duration-150 shadow-sm hover:shadow-md select-none',
          isSelected && 'ring-2 ring-accent z-10 shadow-md',
        )}
      >
        <div className="relative w-full flex-1 min-h-0 z-0 bg-surface">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={filename}
              className="w-full h-full object-contain relative group-hover:scale-[1.02] select-none pointer-events-none"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-surface">
              <ImageIcon className="text-text-secondary animate-pulse" />
            </div>
          )}
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-16 transition-opacity duration-300 pointer-events-none z-10 bg-linear-to-t from-black/75 to-transparent group-hover:opacity-0" />

        <div className="absolute bottom-0 left-0 right-0 flex flex-col p-2 pb-1.5 transition-all duration-300 ease-in-out z-20 bg-transparent group-hover:bg-surface/85 backdrop-blur-none group-hover:backdrop-blur-md border-t border-transparent group-hover:border-border-color/50">
          <div className="flex items-end justify-between shrink-0">
            <span
              className="truncate pr-2 text-xs font-medium text-white transition-colors duration-300"
              title={filename}
            >
              {filename}
            </span>
          </div>

          <div className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out shrink-0 grid-rows-[0fr] opacity-0 group-hover:grid-rows-[1fr] group-hover:opacity-100">
            <div className="overflow-hidden min-h-0">
              <div className="pt-1.5 pb-0.5 flex flex-wrap items-center gap-x-2.5 shrink-0 text-text-secondary">
                {shutter && (
                  <div className="flex items-center gap-1">
                    <IconShutter className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">{shutter}</span>
                  </div>
                )}
                {fNumber && (
                  <div className="flex items-center gap-1">
                    <IconAperture className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">{fNumber}</span>
                  </div>
                )}
                {iso && (
                  <div className="flex items-center gap-1">
                    <IconIso className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">{iso}</span>
                  </div>
                )}
                {focal && (
                  <div className="flex items-center gap-1">
                    <IconFocalLength className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">{focal}</span>
                  </div>
                )}
                {!shutter && !fNumber && !iso && !focal && timestamp && (
                  <span className="text-[9px] font-medium tracking-wide text-text-secondary">{timestamp}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className={clsx(
            'absolute inset-0 rounded-md pointer-events-none z-30 transition-all duration-150 ring-2 ring-inset',
            isSelected ? 'ring-accent' : 'ring-transparent group-hover:ring-hover-color',
          )}
        />
      </div>
    );
  },
);

const UnlocatedDockRow = React.memo((props: any) => {
  const {
    index,
    style,
    unlocatedPhotos,
    selectedDockPaths,
    effectiveSelectedPath,
    localExifMap,
    dockWidth,
    handlePhotoSelect,
    onImageDoubleClick,
    onContextMenu,
    handlePhotoDragStart,
    handlePhotoDragEnd,
    queueThumbnailRequest,
  } = props;

  const photo = unlocatedPhotos[index];
  if (!photo) return null;

  const isSelected = selectedDockPaths.has(photo.path);
  const filename = photo.path.split(/[\\/]/).pop() || '';
  const timestamp = getImageTimestamp(photo, localExifMap[photo.path]);
  const exif = localExifMap[photo.path] || photo.exif;
  const cardHeight = Math.max(120, dockWidth - 16);

  return (
    <div style={style} className="px-2 py-1 box-border">
      <UnlocatedPhotoCard
        photo={photo}
        filename={filename}
        timestamp={timestamp}
        exif={exif}
        isSelected={isSelected}
        cardHeight={cardHeight}
        onSelect={(e) => handlePhotoSelect(photo.path, e)}
        onDoubleClick={() => onImageDoubleClick?.(photo.path)}
        onContextMenu={(e) => onContextMenu?.(e, photo.path)}
        onDragStart={(e) => handlePhotoDragStart(photo, e)}
        onDragEnd={handlePhotoDragEnd}
        onRequestThumb={queueThumbnailRequest}
      />
    </div>
  );
});

interface MapControlsProps {
  onFitBounds: () => void;
  tileStyle: MapStyle;
  onTileStyleChange: (style: MapStyle) => void;
  showThumbnailCards: boolean;
  onToggleThumbnailCards: () => void;
  isDockOpen: boolean;
  onToggleDock: () => void;
  unlocatedCount: number;
  canUndo?: boolean;
  onUndo?: () => void;
}

const MapControls: React.FC<MapControlsProps> = ({
  onFitBounds,
  tileStyle,
  onTileStyleChange,
  showThumbnailCards,
  onToggleThumbnailCards,
  isDockOpen,
  onToggleDock,
  unlocatedCount,
  canUndo,
  onUndo,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
      <button
        onClick={onToggleDock}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 relative ${
          isDockOpen
            ? 'bg-accent/20 border-accent text-accent shadow-accent/20'
            : 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-secondary hover:text-text-primary'
        }`}
        title={t('library.map.toggleDock', {
          defaultValue: 'Unlocated photos panel',
        })}
      >
        <MapPinOff className="w-4 h-4" />
        {unlocatedCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-black text-[9px] font-black px-1.5 py-0.2 rounded-full leading-tight shadow-md">
            {unlocatedCount > 99 ? '99+' : unlocatedCount}
          </span>
        )}
      </button>

      <button
        onClick={onUndo}
        disabled={!canUndo}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 ${
          canUndo
            ? 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-primary hover:text-accent cursor-pointer'
            : 'bg-surface/50 border-border-color/20 text-text-secondary/40 cursor-not-allowed opacity-50'
        }`}
        title={
          canUndo
            ? t('library.map.undoTooltip', { defaultValue: 'Undo GPS change (Ctrl+Z)' })
            : t('library.map.undoDisabled', { defaultValue: 'No GPS changes to undo' })
        }
      >
        <Undo2 className="w-4 h-4" />
      </button>

      <button
        onClick={onFitBounds}
        className="w-9 h-9 rounded-lg bg-surface/90 hover:bg-surface border border-border-color/30 text-text-secondary hover:text-text-primary flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95"
        title={t('library.map.fitBounds', { defaultValue: 'Fit all photos in view' })}
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      <button
        onClick={onToggleThumbnailCards}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 ${
          showThumbnailCards
            ? 'bg-accent/20 border-accent text-accent shadow-accent/20'
            : 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-secondary hover:text-text-primary'
        }`}
        title={
          showThumbnailCards
            ? t('library.map.cardsActive', {
                defaultValue: 'Photo thumbnail cards active (click for compact pins)',
              })
            : t('library.map.pinsActive', { defaultValue: 'Compact pins active (click for photo cards)' })
        }
      >
        <ImageIcon className="w-4 h-4" />
      </button>

      <div className="relative">
        <button
          onClick={() => setShowMenu((prev) => !prev)}
          className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 ${
            showMenu
              ? 'bg-accent border-accent text-button-text'
              : 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-secondary hover:text-text-primary'
          }`}
          title={t('library.map.styleSelector', { defaultValue: 'Select map style' })}
        >
          <Layers className="w-4 h-4" />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-11 w-44 bg-surface/95 border border-border-color/40 rounded-xl shadow-2xl p-1.5 flex flex-col gap-1 backdrop-blur-md z-[1001]">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary px-2 py-1">
              {t('library.map.mapStyle', { defaultValue: 'Map Style' })}
            </span>
            {(Object.values(MAP_LAYERS) as MapLayerConfig[]).map((layer) => (
              <button
                key={layer.id}
                onClick={() => {
                  onTileStyleChange(layer.id);
                  setShowMenu(false);
                }}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition text-left ${
                  tileStyle === layer.id
                    ? 'bg-accent/20 text-accent border border-accent/40 font-medium'
                    : 'text-text-primary hover:bg-hover-color border border-transparent'
                }`}
              >
                <span>{layer.icon}</span>
                <span>{layer.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export interface MapViewProps {
  imageList: Array<ImageFile>;
  activePath: string | null;
  multiSelectedPaths: Array<string>;
  currentFolderPath?: string | null;
  onImageClick(path: string, event: React.MouseEvent | MouseEvent): void;
  onImageDoubleClick(path: string): void;
  onContextMenu(event: React.MouseEvent | MouseEvent, path: string): void;
  onEmptyAreaContextMenu?(event: React.MouseEvent | MouseEvent): void;
  onRequestThumbnails?(paths: string[]): void;
}

interface GpsUndoItem {
  path: string;
  previousLat: number | null;
  previousLon: number | null;
  hadNativeGps?: boolean;
}

interface GpsUndoAction {
  items: GpsUndoItem[];
}

export default function MapView(props: MapViewProps) {
  const [tileStyle, setTileStyle] = useState<MapStyle>(getInitialMapStyle);
  const [showThumbnailCards, setShowThumbnailCards] = useState<boolean>(getInitialShowThumbnails);
  const [isDockOpen, setIsDockOpen] = useState<boolean>(getInitialDockOpen);
  const [dockWidth, setDockWidth] = useState<number>(getInitialDockWidth);
  const [selectedDockPaths, setSelectedDockPaths] = useState<Set<string>>(new Set());
  const [repositioningPhotoPath, setRepositioningPhotoPath] = useState<string | null>(null);
  const [isDraggingOverMap, setIsDraggingOverMap] = useState<boolean>(false);
  const [mapContextMenu, setMapContextMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lon: number;
    targetPaths: string[];
  } | null>(null);

  const exifByPath = useLibraryStore((s) => s.exifByPath);
  const [localExifMap, setLocalExifMap] = useState<Record<string, Record<string, string>>>(() => {
    const initial: Record<string, Record<string, string>> = { ...useLibraryStore.getState().exifByPath };
    for (const img of props.imageList || []) {
      if (img.exif) {
        initial[img.path] = img.exif;
      }
    }
    return initial;
  });
  const requestedExifRef = useRef<Set<string>>(new Set());
  const mapRef = useRef<L.Map | null>(null);
  const isResizing = useRef(false);
  const [isResizingState, setIsResizingState] = useState(false);
  const dockWidthRef = useRef(dockWidth);

  const undoStackRef = useRef<GpsUndoAction[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    dockWidthRef.current = dockWidth;
  }, [dockWidth]);

  const dockListContainerRef = useRef<HTMLDivElement>(null);
  const [dockListHeight, setDockListHeight] = useState(0);

  useEffect(() => {
    const updateHeight = () => {
      if (dockListContainerRef.current) {
        setDockListHeight(dockListContainerRef.current.clientHeight);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    if (dockListContainerRef.current) {
      observer.observe(dockListContainerRef.current);
    }
    window.addEventListener('resize', updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, [isDockOpen]);

  const { t } = useTranslation();

  const handleTileStyleChange = useCallback((style: MapStyle) => {
    setTileStyle(style);
    try {
      localStorage.setItem(MAP_STYLE_STORAGE_KEY, style);
    } catch (e) {
      console.error('Failed to save map style to localStorage', e);
    }
  }, []);

  const handleToggleThumbnailCards = useCallback(() => {
    setShowThumbnailCards((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MAP_SHOW_THUMBNAILS_STORAGE_KEY, String(next));
      } catch (e) {
        console.error('Failed to save show thumbnails setting to localStorage', e);
      }
      return next;
    });
  }, []);

  const handleToggleDock = useCallback(() => {
    setIsDockOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MAP_DOCK_OPEN_STORAGE_KEY, String(next));
      } catch (e) {
        console.error('Failed to save dock open setting to localStorage', e);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      mapRef.current?.invalidateSize();
    }, 220);
    return () => clearTimeout(timer);
  }, [isDockOpen, dockWidth]);

  const resize = useCallback((mouseMoveEvent: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - mouseMoveEvent.clientX;
    if (newWidth >= 160 && newWidth <= 550) {
      dockWidthRef.current = newWidth;
      setDockWidth(newWidth);
    }
  }, []);

  const stopResizing = useCallback(() => {
    if (!isResizing.current) return;
    isResizing.current = false;
    setIsResizingState(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResizing);
    try {
      localStorage.setItem(MAP_DOCK_WIDTH_STORAGE_KEY, String(dockWidthRef.current));
    } catch (e) {
      console.error('Failed to save dock width to localStorage', e);
    }
    mapRef.current?.invalidateSize();
  }, [resize]);

  const startResizing = useCallback(
    (mouseDownEvent: React.MouseEvent) => {
      mouseDownEvent.preventDefault();
      isResizing.current = true;
      setIsResizingState(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', stopResizing);
    },
    [resize, stopResizing],
  );

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', resize);
      document.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  useEffect(() => {
    const handleWindowClick = () => setMapContextMenu(null);
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, []);

  const {
    imageList,
    activePath,
    multiSelectedPaths,
    currentFolderPath,
    onImageClick,
    onImageDoubleClick,
    onContextMenu,
    onRequestThumbnails,
  } = props;

  const editorSelectedPath = useEditorStore((s) => s.selectedImage?.path);
  const libraryActivePath = useLibraryStore((s) => s.libraryActivePath);

  const effectiveSelectedPath = useMemo(() => {
    return (
      activePath ||
      libraryActivePath ||
      editorSelectedPath ||
      (multiSelectedPaths && multiSelectedPaths.length > 0 ? multiSelectedPaths[0] : null) ||
      null
    );
  }, [activePath, libraryActivePath, editorSelectedPath, multiSelectedPaths]);

  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<any>(null);

  const queueThumbnailRequest = useCallback(
    (path: string) => {
      if (!onRequestThumbnails) return;
      if (useProcessStore.getState().thumbnails[path]) return;
      requestQueueRef.current.add(path);
      if (!requestTimeoutRef.current) {
        requestTimeoutRef.current = setTimeout(() => {
          const paths = Array.from(requestQueueRef.current);
          if (paths.length > 0) {
            onRequestThumbnails(paths);
            requestQueueRef.current.clear();
          }
          requestTimeoutRef.current = null;
        }, 50);
      }
    },
    [onRequestThumbnails],
  );

  useEffect(() => {
    requestedExifRef.current.clear();
    setLocalExifMap({ ...useLibraryStore.getState().exifByPath });
    setSelectedDockPaths(new Set());
    setRepositioningPhotoPath(null);
    setMapContextMenu(null);
    undoStackRef.current = [];
    setCanUndo(false);
  }, [currentFolderPath]);

  useEffect(() => {
    if (!imageList || imageList.length === 0) return;
    setLocalExifMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const img of imageList) {
        const storeExif = exifByPath?.[img.path] || img.exif;
        if (storeExif && next[img.path] !== storeExif) {
          next[img.path] = storeExif;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [imageList, exifByPath]);

  useEffect(() => {
    const unrequested = imageList.filter(
      (img) =>
        !img.exif && !exifByPath?.[img.path] && !localExifMap[img.path] && !requestedExifRef.current.has(img.path),
    );
    if (unrequested.length === 0) return;

    unrequested.forEach((img) => requestedExifRef.current.add(img.path));

    let isCancelled = false;
    const loadExif = async () => {
      const chunkSize = 100;

      for (let i = 0; i < unrequested.length; i += chunkSize) {
        if (isCancelled) break;
        const chunk = unrequested.slice(i, i + chunkSize).map((img) => img.path);
        try {
          const chunkExif = await invoke<Record<string, Record<string, string>>>(Invokes.ReadExifForPaths, {
            paths: chunk,
          });
          if (isCancelled) break;

          setLocalExifMap((prev) => ({ ...prev, ...chunkExif }));
          useLibraryStore.getState().setLibrary((state) => ({
            exifByPath: { ...state.exifByPath, ...chunkExif },
          }));
        } catch (err) {
          console.error('Failed to read EXIF for MapView:', err);
        }
      }
    };

    loadExif();
    return () => {
      isCancelled = true;
    };
  }, [imageList.length, currentFolderPath, exifByPath]);

  const { geotaggedPhotos, unlocatedPhotos, totalPhotos, geotaggedCount } = useMemo(() => {
    const items: MapPhotoItem[] = [];
    const unlocated: ImageFile[] = [];

    for (const img of imageList) {
      const exifOverride = localExifMap[img.path] || exifByPath?.[img.path];
      const gps: GeoLocation | null = getImageGps(img, exifOverride);
      if (gps) {
        const filename = img.path.split(/[\\/]/).pop() || '';
        const timestamp = getImageTimestamp(img, exifOverride);
        const hasNative = exifOverride?.HasNativeGPS === 'true' || img.exif?.HasNativeGPS === 'true';
        const isModified = exifOverride?.IsGpsModified === 'true' || img.exif?.IsGpsModified === 'true';

        items.push({
          id: img.path,
          path: img.path,
          filename,
          lat: gps.lat,
          lon: gps.lon,
          timestamp,
          isRaw: img.is_raw,
          image: img,
          hasNativeGps: hasNative,
          isGpsModified: isModified,
        });
      } else {
        unlocated.push(img);
      }
    }
    return {
      geotaggedPhotos: items,
      unlocatedPhotos: unlocated,
      totalPhotos: imageList.length,
      geotaggedCount: items.length,
    };
  }, [imageList, localExifMap, exifByPath]);

  const applyGpsToPhotosInternal = useCallback(
    async (
      paths: string[],
      lat: number | null,
      lon: number | null,
      recordUndo: boolean = true,
      customSuccessMsg?: string,
    ) => {
      if (paths.length === 0) return;

      if (recordUndo) {
        const undoItems: GpsUndoItem[] = [];
        for (const p of paths) {
          const img = imageList.find((i) => i.path === p);
          const currentExif = localExifMap[p] || exifByPath?.[p];
          const currentGps = getImageGps(img, currentExif);
          const hadNative = currentExif?.HasNativeGPS === 'true' || img?.exif?.HasNativeGPS === 'true';
          undoItems.push({
            path: p,
            previousLat: currentGps ? currentGps.lat : null,
            previousLon: currentGps ? currentGps.lon : null,
            hadNativeGps: hadNative,
          });
        }
        undoStackRef.current.push({ items: undoItems });
        setCanUndo(true);
      }

      try {
        await invoke(Invokes.SetGpsForPaths, {
          paths,
          latitude: lat,
          longitude: lon,
        });

        const updates: Record<string, string> = {};
        if (lat !== null && lon !== null) {
          updates.GPSLatitude = toDmsString(lat);
          updates.GPSLatitudeRef = lat >= 0 ? 'N' : 'S';
          updates.GPSLongitude = toDmsString(lon);
          updates.GPSLongitudeRef = lon >= 0 ? 'E' : 'W';
        }

        setLocalExifMap((prev) => {
          const next = { ...prev };
          for (const p of paths) {
            if (lat !== null && lon !== null) {
              const currentExif = next[p] || exifByPath?.[p] || {};
              const hasNative =
                currentExif.HasNativeGPS === 'true' ||
                imageList.find((i) => i.path === p)?.exif?.HasNativeGPS === 'true';
              const modUpdate: Record<string, string> = hasNative ? { IsGpsModified: 'true' } : {};
              next[p] = { ...currentExif, ...updates, ...modUpdate };
            } else if (next[p] || exifByPath?.[p]) {
              const cleaned = { ...(next[p] || exifByPath?.[p] || {}) };
              delete cleaned.GPSLatitude;
              delete cleaned.GPSLatitudeRef;
              delete cleaned.GPSLongitude;
              delete cleaned.GPSLongitudeRef;
              delete cleaned.IsGpsModified;
              next[p] = cleaned;
            }
          }
          return next;
        });

        setSelectedDockPaths((prev) => {
          const next = new Set(prev);
          paths.forEach((p) => next.delete(p));
          return next;
        });

        const normalizePath = (p: string) => p.replace(/\\/g, '/').split('?vc=')[0];
        const pathsNormSet = new Set(paths.map(normalizePath));
        useLibraryStore.getState().setLibrary((state) => {
          const nextExifByPath = { ...state.exifByPath };
          const nextImageList = state.imageList.map((img) => {
            if (pathsNormSet.has(normalizePath(img.path))) {
              const baseExif = nextExifByPath[img.path] || img.exif || localExifMap[img.path];
              if (lat !== null && lon !== null) {
                const hasNative = baseExif?.HasNativeGPS === 'true';
                const modUpdate = hasNative ? { IsGpsModified: 'true' } : {};
                const updatedExif = { ...(baseExif || {}), ...updates, ...modUpdate };
                nextExifByPath[img.path] = updatedExif;
                return { ...img, is_edited: true, exif: updatedExif };
              } else if (baseExif) {
                const cleaned = { ...baseExif };
                delete cleaned.GPSLatitude;
                delete cleaned.GPSLatitudeRef;
                delete cleaned.GPSLongitude;
                delete cleaned.GPSLongitudeRef;
                delete cleaned.IsGpsModified;
                const hadNative = baseExif.HasNativeGPS === 'true';
                nextExifByPath[img.path] = cleaned;
                return { ...img, is_edited: hadNative ? true : img.is_edited, exif: cleaned };
              }
            }
            return img;
          });
          return { imageList: nextImageList, exifByPath: nextExifByPath };
        });

        useEditorStore.getState().setEditor((state) => {
          if (!state.selectedImage || !pathsNormSet.has(normalizePath(state.selectedImage.path))) {
            return state;
          }
          if (lat !== null && lon !== null) {
            const hasNative =
              state.selectedImage.exif?.HasNativeGPS === 'true' ||
              localExifMap[state.selectedImage.path]?.HasNativeGPS === 'true' ||
              exifByPath?.[state.selectedImage.path]?.HasNativeGPS === 'true';
            const modUpdate = hasNative ? { IsGpsModified: 'true' } : {};
            return {
              selectedImage: {
                ...state.selectedImage,
                is_edited: true,
                exif: { ...(state.selectedImage.exif || {}), ...updates, ...modUpdate },
              },
            };
          } else if (state.selectedImage.exif) {
            const cleaned = { ...state.selectedImage.exif };
            delete cleaned.GPSLatitude;
            delete cleaned.GPSLatitudeRef;
            delete cleaned.GPSLongitude;
            delete cleaned.GPSLongitudeRef;
            delete cleaned.IsGpsModified;
            const hadNative =
              state.selectedImage.exif?.HasNativeGPS === 'true' ||
              localExifMap[state.selectedImage.path]?.HasNativeGPS === 'true' ||
              exifByPath?.[state.selectedImage.path]?.HasNativeGPS === 'true';
            return {
              selectedImage: {
                ...state.selectedImage,
                is_edited: hadNative ? true : state.selectedImage.is_edited,
                exif: cleaned,
              },
            };
          }
          return state;
        });

        if (customSuccessMsg) {
          toast.success(customSuccessMsg);
        } else if (lat !== null) {
          const hadPreviousGps = paths.some((p) => {
            const img = imageList.find((i) => i.path === p);
            return Boolean(getImageGps(img, localExifMap[p] || exifByPath?.[p]));
          });

          if (hadPreviousGps) {
            toast.success(
              t('library.map.repositionedSuccess', {
                count: paths.length,
                defaultValue:
                  paths.length === 1
                    ? 'Photo repositioned successfully'
                    : `${paths.length} photos repositioned successfully`,
              }),
            );
          } else {
            toast.success(
              t('library.map.geotagSuccess', {
                count: paths.length,
                defaultValue:
                  paths.length === 1 ? 'Photo geotagged successfully' : `Successfully geotagged ${paths.length} photos`,
              }),
            );
          }
        } else {
          toast.info(
            t('library.map.geotagRemoved', {
              count: paths.length,
              defaultValue:
                paths.length === 1 ? 'GPS coordinates removed' : `GPS coordinates removed for ${paths.length} photos`,
            }),
          );
        }
      } catch (err) {
        console.error('Failed to set GPS coordinates', err);
        toast.error(
          t('library.map.errorSavingGps', {
            defaultValue: `Error saving GPS coordinates: ${err}`,
            err: String(err),
          }),
        );
      }
    },
    [t, imageList, localExifMap, exifByPath],
  );

  const applyGpsToPhotos = useCallback(
    (paths: string[], lat: number | null, lon: number | null) => {
      return applyGpsToPhotosInternal(paths, lat, lon, true);
    },
    [applyGpsToPhotosInternal],
  );

  const handleUndoGps = useCallback(async () => {
    const action = undoStackRef.current.pop();
    setCanUndo(undoStackRef.current.length > 0);
    if (!action || action.items.length === 0) return;

    const groups = new Map<string, { lat: number | null; lon: number | null; paths: string[] }>();
    for (const item of action.items) {
      const key = `${item.previousLat}_${item.previousLon}`;
      if (!groups.has(key)) {
        groups.set(key, { lat: item.previousLat, lon: item.previousLon, paths: [] });
      }
      groups.get(key)!.paths.push(item.path);
    }

    for (const group of groups.values()) {
      await applyGpsToPhotosInternal(group.paths, group.lat, group.lon, false);
    }

    toast.info(t('library.map.undoSuccess', { defaultValue: 'GPS change undone' }));
  }, [applyGpsToPhotosInternal, t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (undoStackRef.current.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          handleUndoGps();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndoGps]);

  const handleRevertGps = useCallback(
    async (path: string) => {
      const normalizePath = (p: string) => p.replace(/\\/g, '/').split('?vc=')[0];
      const targetNorm = normalizePath(path);

      const img = imageList.find((i) => normalizePath(i.path) === targetNorm);
      const currentExif = localExifMap[path] || exifByPath?.[path];
      const currentGps = getImageGps(img || ({ path, is_raw: false } as ImageFile), currentExif);
      if (currentGps) {
        undoStackRef.current.push({
          items: [
            {
              path,
              previousLat: currentGps.lat,
              previousLon: currentGps.lon,
              hadNativeGps: currentExif?.HasNativeGPS === 'true' || img?.exif?.HasNativeGPS === 'true',
            },
          ],
        });
        setCanUndo(true);
      }

      try {
        const result = await invoke<Record<string, [number, number] | null>>(Invokes.RevertGpsForPaths, {
          paths: [path],
        });
        const coords = result[path] !== undefined ? result[path] : result[targetNorm];

        if (coords) {
          const [lat, lon] = coords;
          const updates: Record<string, string> = {
            GPSLatitude: toDmsString(lat),
            GPSLatitudeRef: lat >= 0 ? 'N' : 'S',
            GPSLongitude: toDmsString(lon),
            GPSLongitudeRef: lon >= 0 ? 'E' : 'W',
            HasNativeGPS: 'true',
          };

          setLocalExifMap((prev) => {
            const next = { ...prev };
            const current = next[path]
              ? { ...next[path] }
              : exifByPath?.[path]
                ? { ...exifByPath[path] }
                : img?.exif
                  ? { ...img.exif }
                  : {};
            delete current.IsGpsModified;
            next[path] = { ...current, ...updates };
            if (targetNorm !== path) {
              next[targetNorm] = { ...next[path] };
            }
            return next;
          });

          useLibraryStore.getState().setLibrary((state) => {
            const nextExifByPath = { ...state.exifByPath };
            const nextImageList = state.imageList.map((i) => {
              if (normalizePath(i.path) === targetNorm) {
                const currentExifMap = nextExifByPath[i.path]
                  ? { ...nextExifByPath[i.path] }
                  : i.exif
                    ? { ...i.exif }
                    : {};
                delete currentExifMap.IsGpsModified;
                const updatedExif = { ...currentExifMap, ...updates };
                nextExifByPath[i.path] = updatedExif;
                return { ...i, is_edited: false, exif: updatedExif };
              }
              return i;
            });
            return { imageList: nextImageList, exifByPath: nextExifByPath };
          });

          useEditorStore.getState().setEditor((state) => {
            if (!state.selectedImage || normalizePath(state.selectedImage.path) !== targetNorm) {
              return state;
            }
            const currentExif = state.selectedImage.exif ? { ...state.selectedImage.exif } : {};
            delete currentExif.IsGpsModified;
            return {
              selectedImage: {
                ...state.selectedImage,
                is_edited: false,
                exif: { ...currentExif, ...updates },
              },
            };
          });

          toast.success(
            t('library.map.revertSuccess', {
              count: 1,
              defaultValue: 'Restored original camera GPS coordinates for 1 photo',
            }),
          );
        } else {
          setLocalExifMap((prev) => {
            const next = { ...prev };
            const current = next[path]
              ? { ...next[path] }
              : exifByPath?.[path]
                ? { ...exifByPath[path] }
                : img?.exif
                  ? { ...img.exif }
                  : {};
            delete current.GPSLatitude;
            delete current.GPSLatitudeRef;
            delete current.GPSLongitude;
            delete current.GPSLongitudeRef;
            delete current.IsGpsModified;
            current.HasNativeGPS = 'false';
            next[path] = current;
            if (targetNorm !== path) {
              next[targetNorm] = { ...current };
            }
            return next;
          });

          useLibraryStore.getState().setLibrary((state) => {
            const nextExifByPath = { ...state.exifByPath };
            const nextImageList = state.imageList.map((i) => {
              if (normalizePath(i.path) === targetNorm) {
                const cleaned = nextExifByPath[i.path] ? { ...nextExifByPath[i.path] } : i.exif ? { ...i.exif } : {};
                delete cleaned.GPSLatitude;
                delete cleaned.GPSLatitudeRef;
                delete cleaned.GPSLongitude;
                delete cleaned.GPSLongitudeRef;
                delete cleaned.IsGpsModified;
                cleaned.HasNativeGPS = 'false';
                nextExifByPath[i.path] = cleaned;
                return { ...i, is_edited: false, exif: cleaned };
              }
              return i;
            });
            return { imageList: nextImageList, exifByPath: nextExifByPath };
          });

          useEditorStore.getState().setEditor((state) => {
            if (!state.selectedImage || normalizePath(state.selectedImage.path) !== targetNorm) {
              return state;
            }
            const cleaned = state.selectedImage.exif ? { ...state.selectedImage.exif } : {};
            delete cleaned.GPSLatitude;
            delete cleaned.GPSLatitudeRef;
            delete cleaned.GPSLongitude;
            delete cleaned.GPSLongitudeRef;
            delete cleaned.IsGpsModified;
            cleaned.HasNativeGPS = 'false';
            return { selectedImage: { ...state.selectedImage, is_edited: false, exif: cleaned } };
          });

          toast.info(
            t('library.map.revertCleared', {
              defaultValue: 'Cleared GPS coordinates (no original camera GPS)',
            }),
          );
        }
      } catch (err) {
        console.error('Failed to revert GPS coordinates', err);
        toast.error(
          t('library.map.errorSavingGps', {
            defaultValue: `Error saving GPS coordinates: ${err}`,
            err: String(err),
          }),
        );
      }
    },
    [t, imageList, localExifMap],
  );

  const handleMovePhoto = useCallback(
    async (draggedPaths: string[] | string, lat: number, lon: number) => {
      const paths = Array.isArray(draggedPaths) ? draggedPaths : [draggedPaths];
      if (paths.length === 0) return;
      await applyGpsToPhotos(paths, lat, lon);
    },
    [applyGpsToPhotos],
  );

  const handleMapDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingOverMap(false);
      if (!mapRef.current) return;

      try {
        const rawData = e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain');
        if (!rawData) return;
        const parsed = JSON.parse(rawData);
        const pathsToGeotag: string[] = Array.isArray(parsed?.paths) ? parsed.paths : [];
        if (pathsToGeotag.length === 0) return;

        const container = mapRef.current.getContainer();
        const rect = container.getBoundingClientRect();
        const point = L.point(e.clientX - rect.left, e.clientY - rect.top);
        const latLng = mapRef.current.containerPointToLatLng(point);

        const lat = latLng.lat;
        let lon = ((((latLng.lng + 180) % 360) + 360) % 360) - 180;

        await applyGpsToPhotos(pathsToGeotag, lat, lon);

        mapRef.current.panTo([lat, lon], { animate: true, duration: 0.4 });

        if (pathsToGeotag.length > 0) {
          useLibraryStore.getState().setLibrary({
            multiSelectedPaths: pathsToGeotag,
            libraryActivePath: pathsToGeotag[0],
            selectionAnchorPath: pathsToGeotag[0],
          });
          const photoObj = imageList.find((p) => p.path === pathsToGeotag[0]);
          if (photoObj) {
            useEditorStore.getState().setEditor({ selectedImage: photoObj });
          }
        }
      } catch (err) {
        console.error('Failed to handle drop on map', err);
      }
    },
    [applyGpsToPhotos, imageList],
  );

  const handleStartReposition = useCallback((path: string) => {
    setSelectedDockPaths(new Set());
    setRepositioningPhotoPath(path);
    useLibraryStore.getState().setLibrary({
      multiSelectedPaths: [path],
      libraryActivePath: path,
      selectionAnchorPath: path,
    });
  }, []);

  const handleRepositionSelect = useCallback(
    async (lat: number, lon: number) => {
      if (!repositioningPhotoPath) return;
      const targetPath = repositioningPhotoPath;
      setRepositioningPhotoPath(null);
      await applyGpsToPhotos([targetPath], lat, lon);
      toast.success(
        t('library.map.repositionedSuccess', {
          defaultValue: 'Photo repositioned successfully',
        }),
      );
    },
    [repositioningPhotoPath, applyGpsToPhotos, t],
  );

  const isInternalDockSelectionRef = useRef(false);
  const dockSelectionAnchorRef = useRef<string | null>(null);

  const handleMapPhotoSelect = useCallback(
    (path: string, e?: MouseEvent | React.MouseEvent) => {
      setSelectedDockPaths(new Set());
      dockSelectionAnchorRef.current = null;
      setRepositioningPhotoPath(null);

      const photoObj = imageList.find((p) => p.path === path);
      if (photoObj) {
        useEditorStore.getState().setEditor({ selectedImage: photoObj });
      }

      if (e && onImageClick) {
        onImageClick(path, e as any);
      } else {
        useLibraryStore.getState().setLibrary({
          multiSelectedPaths: [path],
          libraryActivePath: path,
          selectionAnchorPath: path,
        });
      }
    },
    [imageList, onImageClick],
  );

  const handleMapRightClick = useCallback(
    (lat: number, lon: number, screenX: number, screenY: number) => {
      const targetPaths =
        selectedDockPaths.size > 0
          ? Array.from(selectedDockPaths)
          : effectiveSelectedPath
            ? [effectiveSelectedPath]
            : multiSelectedPaths.length > 0
              ? multiSelectedPaths
              : [];

      if (targetPaths.length > 0) {
        setMapContextMenu({
          x: screenX,
          y: screenY,
          lat,
          lon,
          targetPaths,
        });
      }
    },
    [selectedDockPaths, effectiveSelectedPath, multiSelectedPaths],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDraggingOverMap(false);
        setMapContextMenu(null);
        setRepositioningPhotoPath(null);
        if (selectedDockPaths.size > 0) {
          isInternalDockSelectionRef.current = true;
          setSelectedDockPaths(new Set());
          dockSelectionAnchorRef.current = null;
          useLibraryStore.getState().setLibrary({
            multiSelectedPaths: [],
            libraryActivePath: null,
            selectionAnchorPath: null,
          });
          useEditorStore.getState().setEditor({ selectedImage: null });
        }
        return;
      }

      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      if (isCtrlOrCmd && (e.key === 'a' || e.key === 'A')) {
        const target = e.target as HTMLElement | null;
        const isInputField =
          target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

        if (!isInputField && isDockOpen && unlocatedPhotos.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          isInternalDockSelectionRef.current = true;
          const allPaths = unlocatedPhotos.map((p) => p.path);
          const allSelected = allPaths.every((path) => selectedDockPaths.has(path));
          if (allSelected) {
            setSelectedDockPaths(new Set());
            dockSelectionAnchorRef.current = null;
            useLibraryStore.getState().setLibrary({
              multiSelectedPaths: [],
              libraryActivePath: null,
              selectionAnchorPath: null,
            });
            useEditorStore.getState().setEditor({ selectedImage: null });
          } else {
            setSelectedDockPaths(new Set(allPaths));
            dockSelectionAnchorRef.current = allPaths[0] || null;
            useLibraryStore.getState().setLibrary({
              multiSelectedPaths: allPaths,
              libraryActivePath: allPaths[0] || null,
              selectionAnchorPath: allPaths[0] || null,
            });
            const photo = imageList.find((p) => p.path === allPaths[0]);
            if (photo) {
              useEditorStore.getState().setEditor({ selectedImage: photo });
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isDockOpen, unlocatedPhotos, imageList, selectedDockPaths]);

  const handlePhotoSelect = useCallback(
    (path: string, e: React.MouseEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      isInternalDockSelectionRef.current = true;

      if (isShift) {
        const anchor =
          dockSelectionAnchorRef.current ||
          (effectiveSelectedPath && unlocatedPhotos.some((p) => p.path === effectiveSelectedPath)
            ? effectiveSelectedPath
            : null) ||
          path;
        const anchorIdx = unlocatedPhotos.findIndex((p) => p.path === anchor);
        const currentIdx = unlocatedPhotos.findIndex((p) => p.path === path);

        if (anchorIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(anchorIdx, currentIdx);
          const end = Math.max(anchorIdx, currentIdx);
          const rangePaths = unlocatedPhotos.slice(start, end + 1).map((p) => p.path);
          const base = isCtrl ? Array.from(selectedDockPaths) : [];
          const newSelection = Array.from(new Set([...base, ...rangePaths]));

          setSelectedDockPaths(new Set(newSelection));
          dockSelectionAnchorRef.current = anchor;
          useLibraryStore.getState().setLibrary({
            multiSelectedPaths: newSelection,
            libraryActivePath: path,
            selectionAnchorPath: anchor,
          });
          const photo = imageList.find((p) => p.path === path);
          if (photo) {
            useEditorStore.getState().setEditor({ selectedImage: photo });
          }
        }
      } else if (isCtrl) {
        dockSelectionAnchorRef.current = path;
        setSelectedDockPaths((prev) => {
          const base = new Set(prev);
          if (
            base.size === 0 &&
            effectiveSelectedPath &&
            unlocatedPhotos.some((p) => p.path === effectiveSelectedPath)
          ) {
            base.add(effectiveSelectedPath);
          }
          if (base.has(path)) {
            base.delete(path);
          } else {
            base.add(path);
          }
          const nextArr = Array.from(base);
          const newActive = base.has(path) ? path : nextArr[nextArr.length - 1] || null;
          useLibraryStore.getState().setLibrary({
            multiSelectedPaths: nextArr,
            libraryActivePath: newActive,
            selectionAnchorPath: path,
          });
          const photo = newActive ? imageList.find((p) => p.path === newActive) : null;
          useEditorStore.getState().setEditor({ selectedImage: photo || null });
          return base;
        });
      } else {
        dockSelectionAnchorRef.current = path;
        setSelectedDockPaths(new Set([path]));
        useLibraryStore.getState().setLibrary({
          multiSelectedPaths: [path],
          libraryActivePath: path,
          selectionAnchorPath: path,
        });
        const photo = imageList.find((p) => p.path === path);
        if (photo) {
          useEditorStore.getState().setEditor({ selectedImage: photo });
        }
      }
    },
    [effectiveSelectedPath, imageList, unlocatedPhotos, selectedDockPaths],
  );

  const handlePhotoDragStart = useCallback(
    (photo: ImageFile, e: React.DragEvent) => {
      isInternalDockSelectionRef.current = true;
      const pathsToDrag =
        selectedDockPaths.has(photo.path) && selectedDockPaths.size > 1 ? Array.from(selectedDockPaths) : [photo.path];

      if (!selectedDockPaths.has(photo.path)) {
        setSelectedDockPaths(new Set(pathsToDrag));
        dockSelectionAnchorRef.current = photo.path;
      }
      useLibraryStore.getState().setLibrary({
        multiSelectedPaths: pathsToDrag,
        libraryActivePath: photo.path,
        selectionAnchorPath: photo.path,
      });
      useEditorStore.getState().setEditor({ selectedImage: photo });

      e.dataTransfer.setData('application/json', JSON.stringify({ paths: pathsToDrag }));
      e.dataTransfer.setData('text/plain', JSON.stringify({ paths: pathsToDrag }));
      e.dataTransfer.effectAllowed = 'copyMove';

      const ghost = document.createElement('div');
      ghost.style.position = 'fixed';
      ghost.style.left = '0';
      ghost.style.top = '0';
      ghost.style.zIndex = '-9999';
      ghost.style.opacity = '0.01';
      ghost.style.pointerEvents = 'none';
      ghost.style.display = 'flex';
      ghost.style.alignItems = 'center';
      ghost.style.gap = '8px';
      ghost.style.padding = '6px 12px 6px 6px';
      ghost.style.background = '#0f172a';
      ghost.style.color = '#ffffff';
      ghost.style.borderRadius = '10px';
      ghost.style.border = '1.5px solid #0284c7';
      ghost.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';

      const procStore = useProcessStore.getState();
      const thumb = procStore.mediumThumbnails[photo.path] || procStore.thumbnails[photo.path];
      if (thumb) {
        const img = document.createElement('img');
        img.src = thumb;
        img.style.width = '48px';
        img.style.height = '48px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '6px';
        img.style.border = '1px solid rgba(255,255,255,0.2)';
        ghost.appendChild(img);
      }

      const textDiv = document.createElement('div');
      textDiv.style.display = 'flex';
      textDiv.style.flexDirection = 'column';
      textDiv.style.maxWidth = '180px';

      const titleSpan = document.createElement('span');
      titleSpan.style.fontSize = '12px';
      titleSpan.style.fontWeight = '600';
      titleSpan.style.overflow = 'hidden';
      titleSpan.style.textOverflow = 'ellipsis';
      titleSpan.style.whiteSpace = 'nowrap';
      titleSpan.innerText =
        pathsToDrag.length > 1
          ? `📍 ${pathsToDrag.length} ${t('library.map.photosCount', { defaultValue: 'photos' })}`
          : `📍 ${photo.path.split(/[\\/]/).pop()}`;
      textDiv.appendChild(titleSpan);

      ghost.appendChild(textDiv);
      document.body.appendChild(ghost);

      ghost.getBoundingClientRect();

      e.dataTransfer.setDragImage(ghost, 28, 28);
      setTimeout(() => {
        if (document.body.contains(ghost)) {
          document.body.removeChild(ghost);
        }
      }, 0);
    },
    [selectedDockPaths, t, imageList],
  );

  const handlePhotoDragEnd = useCallback(() => {
    setIsDraggingOverMap(false);
  }, []);

  const activeLayer = MAP_LAYERS[tileStyle] || MAP_LAYERS.dark;

  const handleFitBounds = useCallback(() => {
    if (!mapRef.current || geotaggedPhotos.length === 0) return;
    try {
      const latLngs = geotaggedPhotos.map((p) => [p.lat, p.lon] as [number, number]);
      const bounds = L.latLngBounds(latLngs);
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      }
    } catch (e) {
      console.error('Failed to fit bounds', e);
    }
  }, [geotaggedPhotos]);

  const initialSelectedPhoto = useMemo(() => {
    if (!effectiveSelectedPath) return null;
    return geotaggedPhotos.find((p) => p.path === effectiveSelectedPath) || null;
  }, [effectiveSelectedPath, geotaggedPhotos]);

  const initialCenter: [number, number] = useMemo(() => {
    if (initialSelectedPhoto) {
      return [initialSelectedPhoto.lat, initialSelectedPhoto.lon];
    }
    if (geotaggedPhotos.length > 0) {
      return [geotaggedPhotos[0].lat, geotaggedPhotos[0].lon];
    }
    return [20, 0];
  }, [initialSelectedPhoto, geotaggedPhotos]);

  const initialZoom: number = initialSelectedPhoto ? 16 : geotaggedPhotos.length > 0 ? 5 : 2;

  const prevEffectiveSelectedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (isInternalDockSelectionRef.current) {
      isInternalDockSelectionRef.current = false;
      prevEffectiveSelectedPathRef.current = effectiveSelectedPath;
      return;
    }
    if (!effectiveSelectedPath) return;
    if (prevEffectiveSelectedPathRef.current === effectiveSelectedPath) return;
    prevEffectiveSelectedPathRef.current = effectiveSelectedPath;

    const isUnlocated = unlocatedPhotos.some((p) => p.path === effectiveSelectedPath);
    if (isUnlocated) {
      setIsDockOpen(true);
      setSelectedDockPaths((prev) => {
        if (prev.has(effectiveSelectedPath)) {
          return prev;
        }
        return new Set([effectiveSelectedPath]);
      });
      if (!dockSelectionAnchorRef.current) {
        dockSelectionAnchorRef.current = effectiveSelectedPath;
      }
    }
  }, [effectiveSelectedPath, unlocatedPhotos]);

  const dockRowProps = useMemo(
    () => ({
      unlocatedPhotos,
      selectedDockPaths,
      effectiveSelectedPath,
      localExifMap,
      dockWidth,
      handlePhotoSelect,
      onImageDoubleClick,
      onContextMenu,
      handlePhotoDragStart,
      handlePhotoDragEnd,
      queueThumbnailRequest,
    }),
    [
      unlocatedPhotos,
      selectedDockPaths,
      effectiveSelectedPath,
      localExifMap,
      dockWidth,
      handlePhotoSelect,
      onImageDoubleClick,
      onContextMenu,
      handlePhotoDragStart,
      handlePhotoDragEnd,
      queueThumbnailRequest,
    ],
  );

  return (
    <div className="relative flex w-full h-full bg-bg-primary overflow-hidden select-none">
      {isResizingState && <div className="fixed inset-0 z-[9999] cursor-col-resize select-none" />}
      <div
        className="flex-1 h-full relative"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!isDraggingOverMap) setIsDraggingOverMap(true);
        }}
        onDragLeave={(e) => {
          const related = e.relatedTarget as Node | null;
          if (!related || !e.currentTarget.contains(related)) {
            setIsDraggingOverMap(false);
          }
        }}
        onDrop={handleMapDrop}
      >
        <div className="absolute top-4 left-4 z-[1000] flex items-center gap-2 bg-surface/90 border border-border-color/30 backdrop-blur-md px-3 py-1.5 rounded-lg shadow-lg">
          <MapPin className="w-4 h-4 text-accent shrink-0" />
          <span className="text-xs font-medium text-text-primary">
            {t('library.map.badge', {
              count: geotaggedCount,
              total: totalPhotos,
              defaultValue: `${geotaggedCount} / ${totalPhotos} with GPS coordinates`,
            })}
          </span>
        </div>

        {isDraggingOverMap && (
          <div className="absolute inset-0 z-[1100] pointer-events-none border-2 border-accent border-dashed">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-surface/95 border border-accent text-text-primary px-4 py-2 rounded-xl shadow-2xl flex items-center gap-2 animate-in fade-in zoom-in-95 duration-150">
              <MapPin className="w-4 h-4 text-accent animate-bounce" />
              <span className="text-xs font-semibold">
                {t('library.map.dropToGeotag', { defaultValue: 'Drop onto map to geotag' })}
              </span>
            </div>
          </div>
        )}

        {repositioningPhotoPath && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1200] flex items-center gap-3 bg-surface/95 border-2 border-accent text-text-primary px-5 py-2.5 rounded-xl shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-150">
            <MapPin className="w-5 h-5 text-accent animate-bounce" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-accent">
                {t('library.map.repositioningModeTitle', {
                  defaultValue: 'Click on the map to place photo',
                })}
              </span>
              <span className="text-[11px] text-text-secondary">
                {repositioningPhotoPath.split(/[\\/]/).pop()} •{' '}
                {t('library.map.pressEscToCancel', { defaultValue: 'Press ESC to cancel' })}
              </span>
            </div>
            <button
              onClick={() => setRepositioningPhotoPath(null)}
              className="ml-2 text-xs px-2.5 py-1 bg-border-color/40 hover:bg-border-color/70 rounded text-text-primary transition font-medium"
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        )}

        {geotaggedCount === 0 && totalPhotos > 0 && !isDockOpen && (
          <div className="absolute inset-0 z-[999] pointer-events-none flex items-center justify-center">
            <div className="bg-surface/95 border border-border-color/40 backdrop-blur-md p-6 rounded-xl shadow-2xl text-center max-w-sm pointer-events-auto">
              <MapPin className="w-8 h-8 text-text-secondary mx-auto mb-2 opacity-60" />
              <p className="text-sm font-semibold text-text-primary mb-1">
                {t('library.map.noGpsTitle', { defaultValue: 'No GPS coordinates' })}
              </p>
              <p className="text-xs text-text-secondary mb-3">
                {t('library.map.noGpsDesc', {
                  defaultValue: 'None of the photos in this folder contain geographic information in EXIF metadata.',
                })}
              </p>
              <button
                onClick={() => setIsDockOpen(true)}
                className="px-3.5 py-1.5 rounded-lg bg-accent text-button-text text-xs font-semibold shadow hover:opacity-90 transition"
              >
                {t('library.map.openDockToGeotag', { defaultValue: 'Open panel to place them' })}
              </button>
            </div>
          </div>
        )}

        <MapContainer
          center={initialCenter}
          zoom={initialZoom}
          className="w-full h-full"
          ref={mapRef}
          attributionControl={true}
        >
          <TileLayer
            key={activeLayer.id}
            attribution={activeLayer.attribution}
            url={activeLayer.url}
            className={activeLayer.className}
            maxZoom={activeLayer.maxZoom}
          />

          <PhotoClusterLayer
            photos={geotaggedPhotos}
            selectedPath={effectiveSelectedPath}
            multiSelectedPaths={multiSelectedPaths}
            currentFolderPath={currentFolderPath}
            onSelectPhoto={handleMapPhotoSelect}
            onDoubleClickPhoto={onImageDoubleClick}
            onContextMenuPhoto={onContextMenu}
            onRevertGps={handleRevertGps}
            onMovePhoto={handleMovePhoto}
            onMapContextMenu={handleMapRightClick}
            showThumbnailCards={showThumbnailCards}
            onRequestThumbnails={onRequestThumbnails}
            repositioningPath={repositioningPhotoPath}
            onStartReposition={handleStartReposition}
            onRepositionSelect={handleRepositionSelect}
          />
        </MapContainer>

        <MapControls
          onFitBounds={handleFitBounds}
          tileStyle={tileStyle}
          onTileStyleChange={handleTileStyleChange}
          showThumbnailCards={showThumbnailCards}
          onToggleThumbnailCards={handleToggleThumbnailCards}
          isDockOpen={isDockOpen}
          onToggleDock={handleToggleDock}
          unlocatedCount={unlocatedPhotos.length}
          canUndo={canUndo}
          onUndo={handleUndoGps}
        />
      </div>

      <div
        style={{ width: isDockOpen ? dockWidth : 0 }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'none';
          if (isDraggingOverMap) setIsDraggingOverMap(false);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (isDraggingOverMap) setIsDraggingOverMap(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingOverMap(false);
          const rawData = e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain');
          if (rawData) {
            try {
              const parsed = JSON.parse(rawData);
              const paths: string[] = Array.isArray(parsed?.paths) ? parsed.paths : [];
              if (paths.length > 0) {
                isInternalDockSelectionRef.current = true;
                setSelectedDockPaths(new Set(paths));
                dockSelectionAnchorRef.current = paths[0];
                useLibraryStore.getState().setLibrary({
                  multiSelectedPaths: paths,
                  libraryActivePath: paths[0],
                  selectionAnchorPath: paths[0],
                });
                const photo = imageList.find((p) => p.path === paths[0]);
                if (photo) {
                  useEditorStore.getState().setEditor({ selectedImage: photo });
                }
              }
            } catch (err) {
              console.error('Failed to parse dropped data on dock', err);
            }
          }
        }}
        className={`relative shrink-0 border-l border-surface/50 bg-bg-secondary/70 backdrop-blur-md flex flex-col ${
          isResizingState ? '' : 'transition-[width] duration-200 ease-out'
        } z-[1000] ${isDockOpen ? '' : 'overflow-hidden border-none'}`}
      >
        {isDockOpen && (
          <>
            <div
              onMouseDown={startResizing}
              className="absolute top-0 bottom-0 -left-1 w-2.5 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors z-40"
              title={t('library.map.resizeDock', { defaultValue: 'Drag to resize' })}
            />

            <div className="p-3 border-b border-surface/50 flex flex-col gap-1 shrink-0 bg-surface/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MapPinOff className="w-4 h-4 text-amber-500 shrink-0" />
                  <span className="text-xs font-bold text-text-primary uppercase tracking-wide">
                    {t('library.map.unlocatedDockTitle', { defaultValue: 'Unlocated' })}
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-surface border border-border-color/30 text-text-secondary">
                    {unlocatedPhotos.length}
                  </span>
                </div>
                <button
                  onClick={() => setIsDockOpen(false)}
                  className="w-6 h-6 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface/60 transition"
                  title={t('library.map.closeDock', { defaultValue: 'Close panel' })}
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-between mt-1 text-[11px] text-text-secondary">
                <span>
                  {t('library.map.unlocatedDockSubtitle', {
                    defaultValue: 'Drag onto map to geotag',
                  })}
                </span>
                {unlocatedPhotos.length > 1 && (
                  <button
                    onClick={() => {
                      isInternalDockSelectionRef.current = true;
                      const isAllSelected =
                        unlocatedPhotos.length > 0 && unlocatedPhotos.every((p) => selectedDockPaths.has(p.path));

                      if (isAllSelected) {
                        setSelectedDockPaths(new Set());
                        dockSelectionAnchorRef.current = null;
                        useLibraryStore.getState().setLibrary({
                          multiSelectedPaths: [],
                          libraryActivePath: null,
                          selectionAnchorPath: null,
                        });
                        useEditorStore.getState().setEditor({ selectedImage: null });
                      } else {
                        const allPaths = unlocatedPhotos.map((p) => p.path);
                        setSelectedDockPaths(new Set(allPaths));
                        dockSelectionAnchorRef.current = allPaths[0] || null;
                        useLibraryStore.getState().setLibrary({
                          multiSelectedPaths: allPaths,
                          libraryActivePath: allPaths[0] || null,
                          selectionAnchorPath: allPaths[0] || null,
                        });
                        const photo = imageList.find((p) => p.path === allPaths[0]);
                        if (photo) {
                          useEditorStore.getState().setEditor({ selectedImage: photo });
                        }
                      }
                    }}
                    className="text-accent hover:underline text-[10px] font-medium shrink-0 ml-2"
                  >
                    {unlocatedPhotos.length > 0 && unlocatedPhotos.every((p) => selectedDockPaths.has(p.path))
                      ? t('library.map.deselectAll', { defaultValue: 'Deselect all' })
                      : t('library.map.selectAll', { defaultValue: 'Select all' })}
                  </button>
                )}
              </div>
            </div>

            <div ref={dockListContainerRef} className="flex-1 w-full min-h-0 overflow-hidden">
              {unlocatedPhotos.length === 0 ? (
                <div className="m-auto text-center p-6 flex flex-col items-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-2 opacity-80" />
                  <p className="text-xs font-semibold text-text-primary">
                    {t('library.map.allGeotagged', {
                      defaultValue: 'All photos have GPS coordinates',
                    })}
                  </p>
                </div>
              ) : dockListHeight > 0 ? (
                <List
                  rowCount={unlocatedPhotos.length}
                  rowHeight={Math.max(120, dockWidth - 16) + 8}
                  rowComponent={UnlocatedDockRow}
                  rowProps={dockRowProps}
                  className="custom-scrollbar"
                  style={{ height: dockListHeight, width: '100%' }}
                />
              ) : null}
            </div>
          </>
        )}
      </div>

      {mapContextMenu && (
        <div
          style={{ top: mapContextMenu.y, left: mapContextMenu.x }}
          className="fixed z-[2000] bg-surface/95 border border-border-color/40 rounded-xl shadow-2xl p-1.5 backdrop-blur-md flex flex-col min-w-48 text-xs text-text-primary animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2.5 py-1 text-[11px] text-text-secondary border-b border-border-color/20 mb-1 flex items-center gap-1 font-medium">
            <MapPin className="w-3.5 h-3.5 text-accent" />
            <span>
              {mapContextMenu.lat.toFixed(5)}°, {mapContextMenu.lon.toFixed(5)}°
            </span>
          </div>
          {(() => {
            const areTargetsGeotagged = mapContextMenu.targetPaths.some((p) => {
              const img = imageList.find((i) => i.path === p);
              return Boolean(getImageGps(img, localExifMap[p]));
            });

            return (
              <button
                onClick={() => {
                  applyGpsToPhotos(mapContextMenu.targetPaths, mapContextMenu.lat, mapContextMenu.lon);
                  setMapContextMenu(null);
                }}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-accent/20 hover:text-accent transition font-medium"
              >
                <MapPin className="w-4 h-4 text-accent" />
                <span>
                  {areTargetsGeotagged
                    ? t('library.map.repositionSelectedHere', {
                        count: mapContextMenu.targetPaths.length,
                        defaultValue: `Reposition ${mapContextMenu.targetPaths.length} photo(s) here`,
                      })
                    : t('library.map.geotagSelectedHere', {
                        count: mapContextMenu.targetPaths.length,
                        defaultValue: `Place ${mapContextMenu.targetPaths.length} photo(s) here`,
                      })}
                </span>
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
