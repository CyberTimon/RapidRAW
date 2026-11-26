import { TitleItem } from '../../types/video';
import { cssFontFamily } from '../fonts';
import { TEXT_MOTIONS } from './effectRegistry';

export const MIN_TITLE_SIZE = 0.02;
export const MAX_TITLE_SIZE = 0.25;
export const DEFAULT_LINE_HEIGHT = 1.2;
export const DEFAULT_OUTLINE_COLOR = '#000000';

const BACKDROP_COLOR = 'rgba(0, 0, 0, 0.55)';
const SHADOW_ALPHA = 0.45;
const MAX_CHARACTER_CODE = 65535;
const MAX_WORD_CODE = 255;

export interface TitleLayout {
  font: string;
  fontSize: number;
  lines: Array<string>;
  lineHeight: number;
  spacing: number;
  trailing: number;
  outline: number;
  padX: number;
  padY: number;
  width: number;
  height: number;
}

export const titleShadow = (title: TitleItem) => title.shadow ?? (title.backdrop ? 0 : 1);

export const hasTextMotion = (title: TitleItem) =>
  [title.animIn, title.animOut].some((motion) => !!motion && TEXT_MOTIONS.includes(motion.kind));

const defaultFamily = () => getComputedStyle(document.body).fontFamily || 'sans-serif';

const fontFamily = (font: string | null) => (!font ? defaultFamily() : cssFontFamily(font));

const applyFont = (ctx: CanvasRenderingContext2D, layout: Pick<TitleLayout, 'font' | 'spacing'>) => {
  ctx.font = layout.font;
  ctx.letterSpacing = `${layout.spacing}px`;
};

let measureContext: CanvasRenderingContext2D | null = null;

const measuringContext = () => {
  measureContext ??= document.createElement('canvas').getContext('2d');
  return measureContext!;
};

const graphemes = (line: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line), (part) => part.segment);

interface Piece {
  text: string;
  gap: string;
  alone?: boolean;
}

const piecesOf = (line: string, fits: (text: string) => boolean): Array<Piece> =>
  line
    .split(' ')
    .flatMap((word, index) =>
      fits(word)
        ? [{ text: word, gap: index === 0 ? '' : ' ' }]
        : graphemes(word).map((text, part) => ({ text, gap: index > 0 && part === 0 ? ' ' : '', alone: part === 0 })),
    );

const fillLines = (pieces: Array<Piece>, maxWidth: number, measure: (text: string) => number) => {
  const lines: Array<string> = [];
  let current: string | null = null;
  for (const piece of pieces) {
    if (current === null && lines.length > 0 && !piece.text) continue;
    const joined: string = current === null ? piece.text : current + piece.gap + piece.text;
    if (current !== null && (piece.alone || measure(joined) > maxWidth)) {
      lines.push(current.trimEnd());
      current = piece.text || null;
    } else {
      current = joined;
    }
  }
  return [...lines, (current ?? '').trimEnd()];
};

const BALANCE_STEPS = 12;

const wrapLine = (line: string, maxWidth: number, measure: (text: string) => number) => {
  if (measure(line) <= maxWidth) return [line];
  const pieces = piecesOf(line, (text) => measure(text) <= maxWidth);
  let best = fillLines(pieces, maxWidth, measure);
  let low = 0;
  let high = maxWidth;
  for (let step = 0; step < BALANCE_STEPS; step++) {
    const width = (low + high) / 2;
    const attempt = fillLines(pieces, width, measure);
    if (attempt.length <= best.length) {
      best = attempt;
      high = width;
    } else {
      low = width;
    }
  }
  return best;
};

export const layoutTitle = (title: TitleItem, canvasHeight: number, ctx = measuringContext()): TitleLayout => {
  const fontSize = Math.max(1, title.size * canvasHeight);
  const font = `${title.italic ? 'italic ' : ''}${title.bold ? 700 : 500} ${fontSize}px ${fontFamily(title.font)}`;
  const spacing = (title.letterSpacing ?? 0) * fontSize;
  const outline = (title.outline ?? 0) * fontSize;
  applyFont(ctx, { font, spacing });
  const trailing = spacing && spacing - (ctx.measureText('ii').width - 2 * ctx.measureText('i').width);
  const padX = (title.backdrop ? fontSize * 0.45 : fontSize * 0.1) + outline;
  const padY = (title.backdrop ? fontSize * 0.25 : fontSize * 0.05) + outline;
  const measure = (text: string) => ctx.measureText(text).width - trailing;
  const maxWidth = title.wrapWidth ? title.wrapWidth * canvasHeight - padX * 2 : null;
  const lines = title.text
    .split('\n')
    .flatMap((line) => (maxWidth !== null ? wrapLine(line, Math.max(fontSize, maxWidth), measure) : [line]));
  const lineHeight = fontSize * (title.lineHeight ?? DEFAULT_LINE_HEIGHT);
  const textWidth = Math.max(0, ...lines.map(measure));
  return {
    font,
    fontSize,
    lines,
    lineHeight,
    spacing,
    trailing,
    outline,
    padX,
    padY,
    width: Math.ceil(textWidth + padX * 2),
    height: Math.ceil(lines.length * lineHeight + padY * 2),
  };
};

const anchorX = (title: TitleItem, layout: TitleLayout, x: number) =>
  title.align === 'left'
    ? x + layout.padX
    : title.align === 'right'
      ? x + layout.width - layout.padX + layout.trailing
      : x + layout.width / 2 + layout.trailing / 2;

const lineY = (layout: TitleLayout, y: number, index: number) => y + layout.padY + layout.lineHeight * (index + 0.5);

const drawTitleBox = (ctx: CanvasRenderingContext2D, title: TitleItem, layout: TitleLayout, x: number, y: number) => {
  ctx.save();
  if (title.backdrop) {
    ctx.fillStyle = BACKDROP_COLOR;
    ctx.beginPath();
    ctx.roundRect(x, y, layout.width, layout.height, layout.fontSize * 0.2);
    ctx.fill();
  }
  const shadow = titleShadow(title);
  if (shadow > 0) {
    ctx.shadowColor = `rgba(0, 0, 0, ${Math.min(1, SHADOW_ALPHA * shadow)})`;
    ctx.shadowBlur = layout.fontSize * 0.12;
    ctx.shadowOffsetY = layout.fontSize * 0.03;
  }
  applyFont(ctx, layout);
  ctx.textAlign = title.align;
  ctx.textBaseline = 'middle';
  const textX = anchorX(title, layout, x);
  if (layout.outline > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = layout.outline * 2;
    ctx.strokeStyle = title.outlineColor ?? DEFAULT_OUTLINE_COLOR;
    layout.lines.forEach((line, index) => ctx.strokeText(line, textX, lineY(layout, y, index)));
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = title.color;
  layout.lines.forEach((line, index) => ctx.fillText(line, textX, lineY(layout, y, index)));
  ctx.restore();
};

const drawUnits = (ctx: CanvasRenderingContext2D, title: TitleItem, layout: TitleLayout) => {
  applyFont(ctx, layout);
  const textX = anchorX(title, layout, 0);
  const rows = layout.lines.flatMap((line, index) => {
    const parts = graphemes(line);
    return parts.length > 0 ? [{ line, index, parts }] : [];
  });
  let characters = 0;
  let words = 0;
  rows.forEach((row, rowIndex) => {
    const next = rows[rowIndex + 1];
    const top = rowIndex === 0 ? 0 : Math.round(layout.padY + layout.lineHeight * row.index);
    const bottom = next ? Math.round(layout.padY + layout.lineHeight * next.index) : ctx.canvas.height;
    const width = ctx.measureText(row.line).width;
    const start = title.align === 'left' ? textX : title.align === 'right' ? textX - width : textX - width / 2;
    const edges = row.parts.map((_, index) =>
      index === 0 ? 0 : Math.round(start + ctx.measureText(row.parts.slice(0, index).join('')).width),
    );
    let spaced = true;
    row.parts.forEach((part, index) => {
      const blank = !part.trim();
      if (!blank && spaced) words += 1;
      spaced = blank;
      characters += 1;
      const right = edges[index + 1] ?? ctx.canvas.width;
      const code = Math.min(characters, MAX_CHARACTER_CODE);
      ctx.fillStyle = `rgb(${code & 255}, ${code >> 8}, ${Math.min(Math.max(words, 1), MAX_WORD_CODE)})`;
      ctx.fillRect(edges[index], top, Math.max(0, right - edges[index]), bottom - top);
    });
  });
  return { characters, words: Math.max(words, 1) };
};

export interface TitleUnits {
  characters: number;
  words: number;
  pixels: Uint8ClampedArray;
}

export interface TitleRaster {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  units: TitleUnits | null;
}

const createContext = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d');
};

const pixelsOf = (ctx: CanvasRenderingContext2D) => ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;

const titleUnits = (title: TitleItem, layout: TitleLayout, width: number, height: number): TitleUnits | null => {
  const ctx = createContext(width, height);
  if (!ctx) return null;
  return { ...drawUnits(ctx, title, layout), pixels: pixelsOf(ctx) };
};

export const rasterizeTitle = async (title: TitleItem, canvasHeight: number): Promise<TitleRaster | null> => {
  if (!title.text.trim()) return null;
  await document.fonts.load(layoutTitle(title, canvasHeight).font, title.text);
  const layout = layoutTitle(title, canvasHeight);
  const ctx = createContext(Math.max(1, layout.width), Math.max(1, layout.height));
  if (!ctx) return null;
  const { width, height } = ctx.canvas;
  const drawn = layoutTitle(title, canvasHeight, ctx);
  drawTitleBox(ctx, title, drawn, 0, 0);
  return {
    width,
    height,
    pixels: pixelsOf(ctx),
    units: hasTextMotion(title) ? titleUnits(title, drawn, width, height) : null,
  };
};
