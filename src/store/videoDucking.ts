import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { VideoProject } from '../types/video';
import { allItems } from '../utils/video/model';
import { withRevision } from '../utils/video/revisions';
import { useVideoStore } from './useVideoStore';

export const DEFAULT_DUCK_DB = 12;
export const MIN_DUCK_DB = 3;
export const MAX_DUCK_DB = 30;

const REFRESH_DELAY_MS = 400;

export type DuckCurve = Array<[number, number]>;

export const useDuckCurves = create<Record<string, DuckCurve>>(() => ({}));

let generation = 0;

const refreshCurves = async (project: VideoProject | null) => {
  const run = ++generation;
  if (!project || !allItems(project).some((item) => item.type === 'audio' && item.duck)) {
    if (Object.keys(useDuckCurves.getState()).length > 0) useDuckCurves.setState({}, true);
    return;
  }
  const curves = await withRevision(project, (revision) =>
    invoke<Array<{ id: string; points: DuckCurve }>>(Invokes.VideoDuckCurves, { revision }),
  ).catch(() => null);
  if (run !== generation || !curves) return;
  useDuckCurves.setState(Object.fromEntries(curves.map(({ id, points }) => [id, points])), true);
};

export const useDuckCurveSync = () => {
  const project = useVideoStore((state) => state.project);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCurves(project), REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [project]);
};
