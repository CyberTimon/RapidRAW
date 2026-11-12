import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { ImageFile } from '../types/library';
import { Invokes } from '../types/invokes';

export function useImagePreloader(sortedImageList: ImageFile[]) {
  const path = useEditorStore((s) => s.selectedImage?.path ?? null);
  const isReady = useEditorStore((s) => Boolean(s.selectedImage?.isReady));
  const isEditorView = useUIStore((s) => s.activeView === 'editor');

  const listRef = useRef(sortedImageList);
  const previousPathRef = useRef<string | null>(null);
  const directionRef = useRef(1);

  useEffect(() => {
    listRef.current = sortedImageList;
  }, [sortedImageList]);

  useEffect(() => {
    const previousPath = previousPathRef.current;
    previousPathRef.current = path;
    if (!path || !previousPath) return;
    const list = listRef.current;
    const index = list.findIndex((img) => img.path === path);
    const previousIndex = list.findIndex((img) => img.path === previousPath);
    if (index === -1 || previousIndex === -1) return;
    const step = index - previousIndex;
    if (step === 1 || step === 1 - list.length) directionRef.current = 1;
    else if (step === -1 || step === list.length - 1) directionRef.current = -1;
  }, [path]);

  useEffect(() => {
    if (!path || !isReady || !isEditorView) return;
    const list = sortedImageList;
    const index = list.findIndex((img) => img.path === path);
    if (index === -1 || list.length < 2) return;
    const at = (offset: number) => list[(((index + offset) % list.length) + list.length) % list.length].path;
    const direction = directionRef.current >= 0 ? 1 : -1;
    const paths = [at(direction), at(2 * direction), at(-direction)];
    invoke(Invokes.PreloadImages, { anchor: path, paths }).catch((err) => console.warn('Preload request failed:', err));
  }, [path, isReady, isEditorView, sortedImageList]);
}
