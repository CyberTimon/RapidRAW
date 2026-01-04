import { useState, useEffect, useCallback, useRef, useLayoutEffect, type JSX } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, Loader2, Save, Crop, Proportions, LayoutTemplate, Shuffle, RectangleHorizontal, RectangleVertical, Palette } from 'lucide-react';
import { ImageFile, Invokes } from '../ui/AppProperties';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import clsx from 'clsx';

interface CollageModalProps {
  isOpen: boolean;
  onClose(): void;
  onSave(base64Data: string, firstPath: string): Promise<string>;
  sourceImages: ImageFile[];
  thumbnails: Record<string, string>;
}

interface LoadedImage {
  path: string;
  url: string;
  width: number;
  height: number;
}

interface LayoutCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Layout = LayoutCell[];

interface LayoutDefinition {
  layout: Layout;
  icon: JSX.Element;
}

interface ImageState {
  offsetX: number;
  offsetY: number;
}

interface AspectRatioPreset {
  name: string;
  value: number | null;
}

const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { name: '1:1', value: 1 },
  { name: '5:4', value: 5 / 4 },
  { name: '4:3', value: 4 / 3 },
  { name: '3:2', value: 3 / 2 },
  { name: '16:9', value: 16 / 9 },
];

const SvgIcon = ({ layout }: { layout: Layout }) => (
  <svg viewBox="0 0 100 100" className="w-full h-full">
    {layout.map((cell, i) => (
      <rect
        key={i}
        x={cell.x * 100}
        y={cell.y * 100}
        width={cell.width * 100}
        height={cell.height * 100}
        fill="white"
        stroke="grey"
        strokeWidth="6"
      />
    ))}
  </svg>
);

const LAYOUTS: Record<number, LayoutDefinition[]> = {
  1: [
    { layout: [{ x: 0, y: 0, width: 1, height: 1 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 1 }]} /> },
  ],
  2: [
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 2/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 1 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 2/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 1 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 2/3 }, { x: 0, y: 2/3, width: 1, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 2/3 }, { x: 0, y: 2/3, width: 1, height: 1/3 }]} /> },
  ],
  3: [
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 1/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 1 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 1/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 1 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 1/3 }, { x: 0, y: 1/3, width: 1, height: 1/3 }, { x: 0, y: 2/3, width: 1, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 1/3 }, { x: 0, y: 1/3, width: 1, height: 1/3 }, { x: 0, y: 2/3, width: 1, height: 1/3 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 1 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 1 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }]} /> },
  ],
  4: [
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1/3 }, { x: 0.5, y: 1/3, width: 0.5, height: 1/3 }, { x: 0.5, y: 2/3, width: 0.5, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1/3 }, { x: 0.5, y: 1/3, width: 0.5, height: 1/3 }, { x: 0.5, y: 2/3, width: 0.5, height: 1/3 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 1/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 1/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 1/4 }, { x: 0, y: 1/4, width: 1, height: 1/4 }, { x: 0, y: 2/4, width: 1, height: 1/4 }, { x: 0, y: 3/4, width: 1, height: 1/4 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 1/4 }, { x: 0, y: 1/4, width: 1, height: 1/4 }, { x: 0, y: 2/4, width: 1, height: 1/4 }, { x: 0, y: 3/4, width: 1, height: 1/4 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1/4, height: 1 }, { x: 1/4, y: 0, width: 1/4, height: 1 }, { x: 2/4, y: 0, width: 1/4, height: 1 }, { x: 3/4, y: 0, width: 1/4, height: 1 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/4, height: 1 }, { x: 1/4, y: 0, width: 1/4, height: 1 }, { x: 2/4, y: 0, width: 1/4, height: 1 }, { x: 3/4, y: 0, width: 1/4, height: 1 }]} /> },
  ],
  5: [
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1/3, height: 0.5 }, { x: 1/3, y: 0, width: 1/3, height: 0.5 }, { x: 2/3, y: 0, width: 1/3, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 0.5 }, { x: 1/3, y: 0, width: 1/3, height: 0.5 }, { x: 2/3, y: 0, width: 1/3, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.25, height: 0.25 }, { x: 0.75, y: 0, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.25, height: 0.25 }, { x: 0.75, y: 0, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 2/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.25 }, { x: 2/3, y: 0.75, width: 1/3, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 2/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.25 }, { x: 2/3, y: 0.75, width: 1/3, height: 0.25 }]} /> },
  ],
  6: [
    { layout: [{ x: 0, y: 0, width: 1/3, height: 0.5 }, { x: 1/3, y: 0, width: 1/3, height: 0.5 }, { x: 2/3, y: 0, width: 1/3, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 0.5 }, { x: 1/3, y: 0, width: 1/3, height: 0.5 }, { x: 2/3, y: 0, width: 1/3, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.5 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.5 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1/3 }, { x: 0.5, y: 0, width: 0.5, height: 1/3 }, { x: 0, y: 1/3, width: 0.5, height: 1/3 }, { x: 0.5, y: 1/3, width: 0.5, height: 1/3 }, { x: 0, y: 2/3, width: 0.5, height: 1/3 }, { x: 0.5, y: 2/3, width: 0.5, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 1/3 }, { x: 0.5, y: 0, width: 0.5, height: 1/3 }, { x: 0, y: 1/3, width: 0.5, height: 1/3 }, { x: 0.5, y: 1/3, width: 0.5, height: 1/3 }, { x: 0, y: 2/3, width: 0.5, height: 1/3 }, { x: 0.5, y: 2/3, width: 0.5, height: 1/3 }]} /> },
    { layout: [{ x: 0, y: 0, width: 2/3, height: 2/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 0, y: 2/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 2/3, width: 1/3, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 2/3, height: 2/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 0, y: 2/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 2/3, width: 1/3, height: 1/3 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 1/3 }, { x: 0, y: 1/3, width: 1, height: 1/3 }, { x: 0, y: 2/3, width: 0.25, height: 1/3 }, { x: 0.25, y: 2/3, width: 0.25, height: 1/3 }, { x: 0.5, y: 2/3, width: 0.25, height: 1/3 }, { x: 0.75, y: 2/3, width: 0.25, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 1/3 }, { x: 0, y: 1/3, width: 1, height: 1/3 }, { x: 0, y: 2/3, width: 0.25, height: 1/3 }, { x: 0.25, y: 2/3, width: 0.25, height: 1/3 }, { x: 0.5, y: 2/3, width: 0.25, height: 1/3 }, { x: 0.75, y: 2/3, width: 0.25, height: 1/3 }]} /> },
  ],
  7: [
    { layout: [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.25 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.25 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.25 }, { x: 0, y: 0.75, width: 1/3, height: 0.25 }, { x: 1/3, y: 0.75, width: 1/3, height: 0.25 }, { x: 2/3, y: 0.75, width: 1/3, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1/3, height: 0.25 }, { x: 1/3, y: 0.5, width: 1/3, height: 0.25 }, { x: 2/3, y: 0.5, width: 1/3, height: 0.25 }, { x: 0, y: 0.75, width: 1/3, height: 0.25 }, { x: 1/3, y: 0.75, width: 1/3, height: 0.25 }, { x: 2/3, y: 0.75, width: 1/3, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1/3 }, { x: 1/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 0, y: 1/3, width: 1, height: 1/3 }, { x: 0, y: 2/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 2/3, width: 1/3, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 1/3 }, { x: 1/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 0, y: 1/3, width: 1, height: 1/3 }, { x: 0, y: 2/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 2/3, width: 1/3, height: 1/3 }]} /> },
  ],
  8: [
    { layout: [{ x: 0, y: 0, width: 0.25, height: 0.5 }, { x: 0.25, y: 0, width: 0.25, height: 0.5 }, { x: 0.5, y: 0, width: 0.25, height: 0.5 }, { x: 0.75, y: 0, width: 0.25, height: 0.5 }, { x: 0, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.25, height: 0.5 }, { x: 0.25, y: 0, width: 0.25, height: 0.5 }, { x: 0.5, y: 0, width: 0.25, height: 0.5 }, { x: 0.75, y: 0, width: 0.25, height: 0.5 }, { x: 0, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0, y: 0.25, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }, { x: 0, y: 0.5, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 }, { x: 0, y: 0.75, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0, y: 0.25, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.25 }, { x: 0, y: 0.5, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.25 }, { x: 0, y: 0.75, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1/3 }, { x: 1/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 0, y: 1/3, width: 1/3, height: 2/3 }, { x: 1/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 1/3, width: 1/3, height: 2/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 1/3 }, { x: 1/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 0, y: 1/3, width: 1/3, height: 2/3 }, { x: 1/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 1/3, width: 1/3, height: 2/3 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.25 }, { x: 0, y: 0.25, width: 1, height: 0.25 }, { x: 0, y: 0.5, width: 1, height: 0.25 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.25 }, { x: 0, y: 0.25, width: 1, height: 0.25 }, { x: 0, y: 0.5, width: 1, height: 0.25 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }]} /> }
  ],
  9: [
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1/3 }, { x: 1/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 0, y: 1/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 0, y: 2/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 2/3, width: 1/3, height: 1/3 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1/3, height: 1/3 }, { x: 1/3, y: 0, width: 1/3, height: 1/3 }, { x: 2/3, y: 0, width: 1/3, height: 1/3 }, { x: 0, y: 1/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 1/3, width: 1/3, height: 1/3 }, { x: 0, y: 2/3, width: 1/3, height: 1/3 }, { x: 1/3, y: 2/3, width: 1/3, height: 1/3 }, { x: 2/3, y: 2/3, width: 1/3, height: 1/3 }]} /> },
    { layout: [{ x: 0.25, y: 0, width: 0.5, height: 0.25 }, { x: 0, y: 0.25, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { x: 0.75, y: 0.25, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.75, width: 0.5, height: 0.25 }, { x: 0, y: 0, width: 0.25, height: 0.25 }, { x: 0.75, y: 0, width: 0.25, height: 0.25 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0.25, y: 0, width: 0.5, height: 0.25 }, { x: 0, y: 0.25, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { x: 0.75, y: 0.25, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.75, width: 0.5, height: 0.25 }, { x: 0, y: 0, width: 0.25, height: 0.25 }, { x: 0.75, y: 0, width: 0.25, height: 0.25 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 0.25, height: 0.25 }, { x: 0.75, y: 0, width: 0.25, height: 0.25 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 0.25, height: 0.25 }, { x: 0.75, y: 0, width: 0.25, height: 0.25 }, { x: 0, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.75, y: 0.75, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }]} /> },
    { layout: [{ x: 0, y: 0, width: 0.25, height: 1 }, { x: 0.25, y: 0, width: 0.5, height: 0.5 }, { x: 0.75, y: 0, width: 0.25, height: 1 }, { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.25, y: 0, width: 0.25, height: 0.25 }, { x: 0.5, y: 0, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.25, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 0.25, height: 1 }, { x: 0.25, y: 0, width: 0.5, height: 0.5 }, { x: 0.75, y: 0, width: 0.25, height: 1 }, { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.25, height: 0.5 }, { x: 0.25, y: 0, width: 0.25, height: 0.25 }, { x: 0.5, y: 0, width: 0.25, height: 0.25 }, { x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, { x: 0.5, y: 0.25, width: 0.25, height: 0.25 }]} /> },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.25 }, { x: 0, y: 0.25, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { x: 0.75, y: 0.25, width: 0.25, height: 0.5 }, { x: 0, y: 0.75, width: 1, height: 0.25 }, { x: 0, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0, y: 0.75, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }], icon: <SvgIcon layout={[{ x: 0, y: 0, width: 1, height: 0.25 }, { x: 0, y: 0.25, width: 0.25, height: 0.5 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { x: 0.75, y: 0.25, width: 0.25, height: 0.5 }, { x: 0, y: 0.75, width: 1, height: 0.25 }, { x: 0, y: 0, width: 0.5, height: 0.25 }, { x: 0.5, y: 0, width: 0.5, height: 0.25 }, { x: 0, y: 0.75, width: 0.5, height: 0.25 }, { x: 0.5, y: 0.75, width: 0.5, height: 0.25 }]} /> },
  ],
};

const DEFAULT_EXPORT_WIDTH = 3000;
const INITIAL_SPACING = 10;
const INITIAL_BORDER_RADIUS = 8;

export default function CollageModal({ isOpen, onClose, onSave, sourceImages }: CollageModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const [availableLayouts, setAvailableLayouts] = useState<LayoutDefinition[]>([]);
  const [activeLayout, setActiveLayout] = useState<Layout | null>(null);
  const [activeAspectRatio, setActiveAspectRatio] = useState<AspectRatioPreset>(ASPECT_RATIO_PRESETS[0]);
  const [spacing, setSpacing] = useState(INITIAL_SPACING);
  const [borderRadius, setBorderRadius] = useState(INITIAL_BORDER_RADIUS);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [exportWidth, setExportWidth] = useState(DEFAULT_EXPORT_WIDTH);
  
  const [exportHeight, setExportHeight] = useState(
    Math.round(DEFAULT_EXPORT_WIDTH / (ASPECT_RATIO_PRESETS[0].value || 1))
  );

  const [loadedImages, setLoadedImages] = useState<LoadedImage[]>([]);
  const [imageStates, setImageStates] = useState<Record<string, ImageState>>({});
  const [draggingImage, setDraggingImage] = useState<{ index: number; startX: number; startY: number } | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const imageElementsRef = useRef<Record<string, HTMLImageElement>>({});

  const resetImageOffsets = useCallback(() => {
    const initialStates: Record<string, ImageState> = {};
    loadedImages.forEach(img => {
      initialStates[img.path] = { offsetX: 0, offsetY: 0 };
    });
    setImageStates(initialStates);
  }, [loadedImages]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setIsLoading(true);
        setIsSaving(false);
        setError(null);
        setSavedPath(null);
        setLoadedImages([]);
        setImageStates({});
        imageElementsRef.current = {};
        setActiveLayout(null);
        setActiveAspectRatio(ASPECT_RATIO_PRESETS[0]);
        setBackgroundColor('#FFFFFF');
        setSpacing(INITIAL_SPACING);
        setBorderRadius(INITIAL_BORDER_RADIUS);
        setExportWidth(DEFAULT_EXPORT_WIDTH);
        setExportHeight(Math.round(DEFAULT_EXPORT_WIDTH / (ASPECT_RATIO_PRESETS[0].value || 1)));
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || sourceImages.length === 0) return;

    const loadImages = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const imagePromises = sourceImages.map(async (imageFile) => {
          const metadata: any = await invoke(Invokes.LoadMetadata, { path: imageFile.path });
          const adjustments = metadata.adjustments && !metadata.adjustments.is_null ? metadata.adjustments : {};
          
          const imageData: Uint8Array = await invoke(Invokes.GeneratePreviewForPath, { path: imageFile.path, jsAdjustments: adjustments });
          
          const blob = new Blob([imageData], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          
          return new Promise<LoadedImage>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              imageElementsRef.current[imageFile.path] = img;
              resolve({ path: imageFile.path, url, width: img.width, height: img.height });
            };
            img.onerror = () => reject(new Error(`Failed to load image: ${imageFile.path}`));
            img.src = url;
          });
        });

        const results = await Promise.all(imagePromises);
        setLoadedImages(results);

        const initialStates: Record<string, ImageState> = {};
        results.forEach(img => {
          initialStates[img.path] = { offsetX: 0, offsetY: 0 };
        });
        setImageStates(initialStates);

      } catch (err: any) {
        console.error("Failed to load images for collage:", err);
        setError(err.message || 'Could not load one or more images.');
      } finally {
        setIsLoading(false);
      }
    };

    const timerId = setTimeout(loadImages, 300);

    return () => {
      clearTimeout(timerId);
      Object.values(imageElementsRef.current).forEach(img => URL.revokeObjectURL(img.src));
    };
  }, [isOpen, sourceImages]);

  useEffect(() => {
    if (loadedImages.length > 0) {
      const layoutsForCount = LAYOUTS[loadedImages.length] || [];
      setAvailableLayouts(layoutsForCount);

      if (activeLayout === null && layoutsForCount.length > 0) {
        setActiveLayout(layoutsForCount[0].layout);
      }
    } else {
      setAvailableLayouts([]);
      setActiveLayout(null);
    }
  }, [loadedImages, activeLayout]);

  useLayoutEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const updatePreviewSize = () => {
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      if (containerWidth === 0 || containerHeight === 0) return;

      const ratio = activeAspectRatio.value || (16 / 9);

      let newWidth, newHeight;
      if (containerWidth / containerHeight > ratio) {
        newHeight = containerHeight;
        newWidth = containerHeight * ratio;
      } else {
        newWidth = containerWidth;
        newHeight = containerWidth / ratio;
      }
      setPreviewSize({ width: newWidth, height: newHeight });
    };

    if (!isLoading) {
      updatePreviewSize();
    }

    const resizeObserver = new ResizeObserver(updatePreviewSize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [activeAspectRatio, isLoading]);

  const drawCanvas = useCallback((canvas: HTMLCanvasElement | null, isExport: boolean = false) => {
    if (!canvas || !activeLayout || loadedImages.length === 0 || (previewSize.width === 0 && !isExport)) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let canvasWidth, canvasHeight, exportScale = 1;
    const dpr = isExport ? 1 : window.devicePixelRatio || 1;

    if (isExport) {
      canvasWidth = exportWidth;
      canvasHeight = exportHeight;
      if (previewSize.width > 0) {
        exportScale = exportWidth / previewSize.width;
      }
    } else {
      canvasWidth = previewSize.width;
      canvasHeight = previewSize.height;
    }

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    loadedImages.forEach((image, index) => {
      const cell = activeLayout[index];
      if (!cell) return;

      const img = imageElementsRef.current[image.path];
      if (!img) return;

      const scaledSpacing = spacing * exportScale;
      const scaledRadius = borderRadius * exportScale;

      const x1 = cell.x * canvasWidth;
      const y1 = cell.y * canvasHeight;
      const x2 = (cell.x + cell.width) * canvasWidth;
      const y2 = (cell.y + cell.height) * canvasHeight;

      const cellFinalX = x1 + (cell.x === 0 ? scaledSpacing : scaledSpacing / 2);
      const cellFinalY = y1 + (cell.y === 0 ? scaledSpacing : scaledSpacing / 2);
      const cellFinalWidth = (x2 - x1) - (cell.x === 0 ? scaledSpacing : scaledSpacing / 2) - (cell.x + cell.width >= 1 ? scaledSpacing : scaledSpacing / 2);
      const cellFinalHeight = (y2 - y1) - (cell.y === 0 ? scaledSpacing : scaledSpacing / 2) - (cell.y + cell.height >= 1 ? scaledSpacing : scaledSpacing / 2);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(cellFinalX, cellFinalY, cellFinalWidth, cellFinalHeight, scaledRadius);
      ctx.clip();

      const imageState = imageStates[image.path] || { offsetX: 0, offsetY: 0 };
      const imageRatio = img.width / img.height;
      const cellRatio = cellFinalWidth / cellFinalHeight;

      let drawWidth, drawHeight, drawX, drawY;

      if (imageRatio > cellRatio) {
        drawHeight = cellFinalHeight;
        drawWidth = drawHeight * imageRatio;
        drawX = cellFinalX + imageState.offsetX * exportScale;
        drawY = cellFinalY;
      } else {
        drawWidth = cellFinalWidth;
        drawHeight = drawWidth / imageRatio;
        drawX = cellFinalX;
        drawY = cellFinalY + imageState.offsetY * exportScale;
      }

      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      ctx.restore();
    });
  }, [activeLayout, loadedImages, imageStates, spacing, borderRadius, previewSize, exportWidth, exportHeight, backgroundColor]);

  useEffect(() => {
    drawCanvas(previewCanvasRef.current);
  }, [drawCanvas]);

  const handleAspectRatioChange = (preset: AspectRatioPreset) => {
    setActiveAspectRatio(preset);
    const ratio = preset.value;
    if (ratio) {
      setExportHeight(Math.round(exportWidth / ratio));
    }
    resetImageOffsets();
  };

  const handleOrientationToggle = () => {
    if (activeAspectRatio && activeAspectRatio.value && activeAspectRatio.value !== 1) {
      const newRatio = 1 / activeAspectRatio.value;
      setActiveAspectRatio(prev => ({ ...prev, value: newRatio }));
      setExportHeight(Math.round(exportWidth / newRatio));
      resetImageOffsets();
    }
  };

  const handleExportDimChange = (e: React.ChangeEvent<HTMLInputElement>, dimension: 'width' | 'height') => {
    const value = parseInt(e.target.value, 10) || 0;
    const ratio = activeAspectRatio.value;

    if (dimension === 'width') {
      setExportWidth(value);
      if (ratio) {
        setExportHeight(Math.round(value / ratio));
      }
    } else {
      setExportHeight(value);
      if (ratio) {
        setExportWidth(Math.round(value * ratio));
      }
    }
  };

  const handleShuffleImages = () => {
    setLoadedImages(prevImages => {
        const shuffled = [...prevImages];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    });
  };

  const handleLayoutChange = (layout: Layout) => {
    setActiveLayout(layout);
    resetImageOffsets();
  };

  const handleSave = async () => {
    if (isSaving || !activeLayout) return;
    setIsSaving(true);
    setError(null);
    try {
      const offscreenCanvas = document.createElement('canvas');
      drawCanvas(offscreenCanvas, true);
      const base64Data = offscreenCanvas.toDataURL('image/png');
      const path = await onSave(base64Data, sourceImages[0].path);
      setSavedPath(path);
    } catch (err: any) {
      console.error("Failed to save collage:", err);
      setError(err.message || 'Could not save the collage.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!previewCanvasRef.current || !activeLayout) return;
    const canvas = previewCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const clickedIndex = activeLayout.findIndex(cell => {
      const x1 = cell.x * previewSize.width;
      const y1 = cell.y * previewSize.height;
      const x2 = (cell.x + cell.width) * previewSize.width;
      const y2 = (cell.y + cell.height) * previewSize.height;
      return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    });

    if (clickedIndex !== -1) {
      setDraggingImage({ index: clickedIndex, startX: e.clientX, startY: e.clientY });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingImage || !previewCanvasRef.current || !activeLayout) return;
    
    const imagePath = loadedImages[draggingImage.index].path;
    const imageState = imageStates[imagePath];
    const img = imageElementsRef.current[imagePath];
    const cell = activeLayout[draggingImage.index];

    const x1 = cell.x * previewSize.width;
    const y1 = cell.y * previewSize.height;
    const x2 = (cell.x + cell.width) * previewSize.width;
    const y2 = (cell.y + cell.height) * previewSize.height;
    const cellFinalWidth = (x2 - x1) - (cell.x === 0 ? spacing : spacing / 2) - (cell.x + cell.width >= 1 ? spacing : spacing / 2);
    const cellFinalHeight = (y2 - y1) - (cell.y === 0 ? spacing : spacing / 2) - (cell.y + cell.height >= 1 ? spacing : spacing / 2);

    const imageRatio = img.width / img.height;
    const cellRatio = cellFinalWidth / cellFinalHeight;

    const dx = e.clientX - draggingImage.startX;
    const dy = e.clientY - draggingImage.startY;

    let newOffsetX = imageState.offsetX;
    let newOffsetY = imageState.offsetY;

    if (imageRatio > cellRatio) {
      newOffsetX = imageState.offsetX + dx;
      const maxOffset = 0;
      const minOffset = cellFinalWidth - (cellFinalHeight * imageRatio);
      newOffsetX = Math.max(minOffset, Math.min(maxOffset, newOffsetX));
    } else {
      newOffsetY = imageState.offsetY + dy;
      const maxOffset = 0;
      const minOffset = cellFinalHeight - (cellFinalWidth / imageRatio);
      newOffsetY = Math.max(minOffset, Math.min(maxOffset, newOffsetY));
    }

    setImageStates(prev => ({
      ...prev,
      [imagePath]: { ...prev[imagePath], offsetX: newOffsetX, offsetY: newOffsetY }
    }));

    setDraggingImage({ ...draggingImage, startX: e.clientX, startY: e.clientY });
  };

  const handleMouseUp = () => {
    setDraggingImage(null);
  };

  const renderControls = () => (
    <div className="w-80 flex-shrink-0 bg-bg-secondary p-4 flex flex-col gap-6 overflow-y-auto">
      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2"><LayoutTemplate size={16} /> Layout</span>
          {availableLayouts.length > 0 && (
            <button onClick={handleShuffleImages} title="Shuffle Images" className="p-1.5 rounded-md hover:bg-surface">
              <Shuffle size={16} />
            </button>
          )}
        </h4>
        <div className="grid grid-cols-3 gap-2">
          {availableLayouts.length > 0 ? availableLayouts.map((item, index) => (
            <button key={index} onClick={() => handleLayoutChange(item.layout)} className={clsx('p-2 rounded-md bg-surface hover:bg-card-active', { 'ring-2 ring-accent': item.layout === activeLayout })}>
              <div className="w-full h-8">
                {item.icon}
              </div>
            </button>
          )) : <p className="text-xs text-text-tertiary col-span-3">No layouts available for {sourceImages.length} images.</p>}
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2"><Crop size={16} /> Aspect Ratio</span>
          <button
            className="p-1.5 rounded-md hover:bg-surface disabled:text-text-tertiary disabled:cursor-not-allowed"
            disabled={!activeAspectRatio.value || activeAspectRatio.value === 1}
            onClick={handleOrientationToggle}
            title="Switch Orientation"
          >
            {activeAspectRatio.value && activeAspectRatio.value < 1 ? (
              <RectangleVertical size={16} />
            ) : (
              <RectangleHorizontal size={16} />
            )}
          </button>
        </h4>
        <div className="grid grid-cols-3 gap-2">
          {ASPECT_RATIO_PRESETS.map(preset => (
            <button key={preset.name} onClick={() => handleAspectRatioChange(preset)} className={clsx('px-2 py-1.5 text-sm rounded-md transition-colors', activeAspectRatio.name === preset.name ? 'bg-accent text-button-text' : 'bg-surface hover:bg-card-active')}>
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Slider 
          label="Spacing"
          min={0} 
          max={50} 
          step={1}
          defaultValue={INITIAL_SPACING}
          value={spacing} 
          onChange={e => setSpacing(Number(e.target.value))} 
        />
      </div>

      <div className="space-y-2">
        <Slider 
          label="Border Radius"
          min={0} 
          max={50} 
          step={1}
          defaultValue={INITIAL_BORDER_RADIUS}
          value={borderRadius} 
          onChange={e => setBorderRadius(Number(e.target.value))} 
        />
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2"><Palette size={16} /> Background</h4>
        <div className="flex items-center gap-2 bg-surface p-2 rounded-md">
          <input 
            type="color" 
            value={backgroundColor} 
            onChange={e => setBackgroundColor(e.target.value)}
            className="w-8 h-8 p-0 border-none rounded cursor-pointer bg-transparent"
          />
          <input 
            type="text" 
            value={backgroundColor} 
            onChange={e => setBackgroundColor(e.target.value)}
            className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent"
            onFocus={e => e.target.select()}
          />
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2"><Proportions size={16} /> Export Size (px)</h4>
        <div className="flex items-center gap-2">
          <input type="number" value={exportWidth} onChange={e => handleExportDimChange(e, 'width')} className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent" placeholder="W" />
          <span className="text-text-tertiary">×</span>
          <input type="number" value={exportHeight} onChange={e => handleExportDimChange(e, 'height')} className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent" placeholder="H" />
        </div>
      </div>
    </div>
  );

  const renderContent = () => {
    if (savedPath) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">Collage Saved!</h3>
          <p className="text-sm text-text-secondary max-w-xs">Your collage has been saved successfully.</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">An Error Occurred</h3>
          <p className="text-sm text-text-secondary max-w-xs">{error}</p>
        </div>
      );
    }

    return (
      <div className="flex flex-row h-full w-full" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
        <div ref={previewContainerRef} className="flex-grow h-full flex items-center justify-center bg-bg-secondary p-4 relative min-w-0">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-10">
              <Loader2 className="w-12 h-12 text-accent animate-spin" />
            </div>
          )}
          <canvas ref={previewCanvasRef} className={clsx('shadow-lg', draggingImage ? 'cursor-grabbing' : 'cursor-grab')} onMouseDown={handleMouseDown} />
        </div>
        {renderControls()}
      </div>
    );
  };

  const renderButtons = () => {
    if (savedPath) {
      return <Button onClick={onClose}>Done</Button>;
    }
    if (error) {
      return <Button onClick={onClose}>Close</Button>;
    }
    return (
      <>
        <button onClick={onClose} className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors">Cancel</button>
        <Button onClick={handleSave} disabled={isSaving || isLoading || !activeLayout}>
          {isSaving ? <Loader2 className="animate-spin mr-2" /> : <Save size={16} className="mr-2" />}
          {isSaving ? 'Saving...' : 'Save Collage'}
        </Button>
      </>
    );
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${show ? 'opacity-100' : 'opacity-0'}`}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <AnimatePresence>
        {show && (
          <motion.div
            className="bg-surface rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <div className="flex-grow min-h-0">
              {renderContent()}
            </div>
            <div className="flex-shrink-0 p-4 flex justify-end gap-3 border-t border-surface">
              {renderButtons()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}