import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { useVideoStore } from './useVideoStore';
import { jobStatusFeed } from './videoJobs';

export type ProxyState = { state: 'none' | 'queued' | 'ready' } | { state: 'running'; progress: number };

interface ProxyStates {
  states: Record<string, ProxyState>;
}

export const useProxyStates = create<ProxyStates>(() => ({ states: {} }));

const projectVideoPaths = () =>
  (useVideoStore.getState().project?.media ?? []).filter((media) => media.kind === 'video').map((media) => media.path);

const proxies = jobStatusFeed<ProxyState>('proxy', useProxyStates, async (publish) => {
  const paths = projectVideoPaths();
  publish(
    paths.length > 0
      ? await invoke<Record<string, ProxyState>>(Invokes.VideoProxyStatus, { paths }).catch(() => ({}))
      : {},
  );
});

export const useProxyState = (path: string | null | undefined) => {
  useEffect(() => proxies.watch(), []);
  return useProxyStates((state) => (path ? state.states[path] : undefined));
};

export const useProxyStateMap = () => {
  useEffect(() => proxies.watch(), []);
  return useProxyStates((state) => state.states);
};

export const isCreatingProxy = (proxy: ProxyState | undefined) =>
  proxy?.state === 'queued' || proxy?.state === 'running';
