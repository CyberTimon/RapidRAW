import { v4 as uuidv4 } from 'uuid';
import { Caption, CaptionStyle, Captions, FrameRate, Ticks, TitleItem, VideoProject } from '../../types/video';
import { identityTransform } from './model';
import { animated } from './animation';
import { pad, secondsToTicks, snapTicks, ticksToSeconds } from './time';
import { layoutTitle } from './titles';

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  size: 0.045,
  color: '#ffffff',
  bold: false,
  backdrop: true,
  y: 0.4,
};

export const SUBTITLE_EXTENSIONS = ['srt', 'vtt'];

export const emptyCaptions = (): Captions => ({ enabled: true, style: DEFAULT_CAPTION_STYLE, items: [] });

export const removeCaptions = (project: VideoProject, ids: Array<string>): VideoProject => {
  const drop = new Set(ids);
  return project.captions?.items.some((caption) => drop.has(caption.id))
    ? {
        ...project,
        captions: { ...project.captions, items: project.captions.items.filter((caption) => !drop.has(caption.id)) },
      }
    : project;
};

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

const parseTime = (value: string) => {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis.padEnd(3, '0')) / 1000;
};

export const sortedCaptions = (items: Array<Caption>) => [...items].sort((a, b) => a.start - b.start);

const withoutOverlaps = (items: Array<Caption>) => {
  const kept: Array<Caption> = [];
  for (const caption of sortedCaptions(items)) {
    const previous = kept.at(-1);
    if (!previous || previous.start + previous.duration <= caption.start) {
      kept.push(caption);
    } else if (previous.start === caption.start) {
      kept[kept.length - 1] = {
        ...previous,
        duration: Math.max(previous.duration, caption.duration),
        text: `${previous.text}\n${caption.text}`,
      };
    } else {
      kept[kept.length - 1] = { ...previous, duration: caption.start - previous.start };
      kept.push(caption);
    }
  }
  return kept;
};

const overlaps = (a: Caption, b: Caption) => a.start < b.start + b.duration && b.start < a.start + a.duration;

export const appendCaptions = (items: Array<Caption>, added: Array<Caption>) => [
  ...items,
  ...added.filter((caption) => !items.some((item) => overlaps(item, caption))),
];

export const parseSubtitles = (text: string): Array<Caption> => {
  const blocks = text
    .replace(/\r/g, '')
    .replace(/^WEBVTT.*\n/, '')
    .split(/\n\s*\n/);
  const parsed = blocks.flatMap((block) => {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) return [];
    const [from, to] = lines[timing].split('-->');
    const start = parseTime(from);
    const end = parseTime(to.split(' ').filter(Boolean)[0] ?? '');
    const content = lines
      .slice(timing + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (start === null || end === null || end <= start || !content) return [];
    return [{ id: uuidv4(), start: secondsToTicks(start), duration: secondsToTicks(end - start), text: content }];
  });
  return withoutOverlaps(parsed);
};

const formatTime = (ticks: number, separator: string) => {
  const totalMillis = Math.max(0, Math.round(ticksToSeconds(ticks) * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const seconds = Math.floor((totalMillis % 60000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(totalMillis % 1000, 3)}`;
};

const cues = (captions: Array<Caption>, separator: string) =>
  sortedCaptions(captions).map(
    (caption) =>
      `${formatTime(caption.start, separator)} --> ${formatTime(caption.start + caption.duration, separator)}\n${caption.text}\n`,
  );

export const formatSrt = (captions: Array<Caption>) =>
  cues(captions, ',')
    .map((cue, index) => `${index + 1}\n${cue}`)
    .join('\n');

export const formatVtt = (captions: Array<Caption>) => `WEBVTT\n\n${cues(captions, '.').join('\n')}`;

const TITLE_SAFE_WIDTH = 0.9;

export const captionAsTitle = (caption: Caption, style: CaptionStyle, aspect?: number): TitleItem => ({
  id: caption.id,
  type: 'title',
  start: caption.start,
  duration: caption.duration,
  fadeIn: 0,
  fadeOut: 0,
  text: caption.text,
  ...(aspect && { wrapWidth: aspect * TITLE_SAFE_WIDTH }),
  font: style.font ?? null,
  size: style.size,
  color: style.color,
  bold: style.bold,
  italic: false,
  align: 'center',
  backdrop: style.backdrop,
  transform: { ...identityTransform(), y: animated(style.y) },
  blend: 'normal',
});

export const captionAt = (items: Array<Caption>, time: Ticks) =>
  items.find((caption) => time >= caption.start && time < caption.start + caption.duration) ?? null;

export const captionRoom = (items: Array<Caption>, time: Ticks) =>
  captionAt(items, time)
    ? 0
    : Math.min(Number.POSITIVE_INFINITY, ...items.filter((item) => item.start > time).map((item) => item.start - time));

export interface SpokenWord {
  start: number;
  end: number;
  text: string;
}

const MAX_LINES = 2;
const MIN_LINE_CHARS = 14;
const MAX_LINE_CHARS = 42;
const SAFE_WIDTH = 0.86;
const WIDTH_SAMPLE = 'When everything looks good, we export the Video';
const WIDE_TEXT_MARGIN = 1.1;
const MAX_CAPTION_SECONDS = 6;
const PAUSE_SECONDS = 0.6;
const LEAD_SECONDS = 0.05;
const LINGER_SECONDS = 0.4;
const MIN_CAPTION_SECONDS = 0.8;
const CLAUSE_BONUS = 0.15;
const LINE_CLAUSE_BONUS = 0.25;
const SENTENCE_END = /[.!?…]["'”»)]*$/;
const CLAUSE_END = /[,;:–—]["'”»)]*$/;

export const captionLineLength = (width: number, height: number, style: CaptionStyle) => {
  const sample = layoutTitle(captionAsTitle({ id: '', start: 0, duration: 1, text: WIDTH_SAMPLE }, style), height);
  const charWidth = ((sample.width - sample.padX * 2) / WIDTH_SAMPLE.length) * WIDE_TEXT_MARGIN;
  const fitting = Math.floor((width * SAFE_WIDTH - sample.padX * 2) / Math.max(1, charWidth));
  return Math.min(MAX_LINE_CHARS, Math.max(MIN_LINE_CHARS, fitting));
};

const textLength = (words: Array<SpokenWord>) =>
  words.reduce((length, word) => length + word.text.length, Math.max(0, words.length - 1));

const splitPhrases = (words: Array<SpokenWord>) => {
  const phrases: Array<Array<SpokenWord>> = [];
  let current: Array<SpokenWord> = [];
  for (const word of words) {
    const last = current.at(-1);
    if (last && (word.start - last.end > PAUSE_SECONDS || SENTENCE_END.test(last.text))) {
      phrases.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
};

const balancePhrase = (words: Array<SpokenWord>, capacity: number) => {
  const clauseBonus = capacity * capacity * CLAUSE_BONUS;
  const cost = new Array<number>(words.length + 1).fill(Infinity);
  const from = new Array<number>(words.length + 1).fill(0);
  cost[0] = 0;
  for (let end = 1; end <= words.length; end++) {
    for (let begin = end - 1; begin >= 0; begin--) {
      const length = textLength(words.slice(begin, end));
      const isTooLong = length > capacity || words[end - 1].end - words[begin].start > MAX_CAPTION_SECONDS;
      if (isTooLong && end - begin > 1) break;
      const slack = Math.max(0, capacity - length);
      const bonus = end < words.length && CLAUSE_END.test(words[end - 1].text) ? clauseBonus : 0;
      const total = cost[begin] + slack * slack - bonus;
      if (total < cost[end]) {
        cost[end] = total;
        from[end] = begin;
      }
    }
  }
  const pieces: Array<Array<SpokenWord>> = [];
  for (let end = words.length; end > 0; end = from[end]) pieces.unshift(words.slice(from[end], end));
  return pieces;
};

const layoutLines = (words: Array<SpokenWord>, lineLength: number) => {
  const text = words.map((word) => word.text).join(' ');
  if (text.length <= lineLength || words.length < 2) return text;
  let best = 1;
  let bestCost = Infinity;
  for (let split = 1; split < words.length; split++) {
    const cost =
      Math.max(textLength(words.slice(0, split)), textLength(words.slice(split))) -
      (CLAUSE_END.test(words[split - 1].text) ? lineLength * LINE_CLAUSE_BONUS : 0);
    if (cost < bestCost) {
      best = split;
      bestCost = cost;
    }
  }
  return `${words
    .slice(0, best)
    .map((word) => word.text)
    .join(' ')}
${words
  .slice(best)
  .map((word) => word.text)
  .join(' ')}`;
};

export const captionsFromWords = (words: Array<SpokenWord>, lineLength: number, fps: FrameRate): Array<Caption> => {
  const groups = splitPhrases(words.filter((word) => word.text.length > 0)).flatMap((phrase) =>
    balancePhrase(phrase, lineLength * MAX_LINES),
  );
  const captions: Array<Caption> = [];
  let previousEnd = 0;
  groups.forEach((group, index) => {
    const next = groups[index + 1]?.[0].start ?? Infinity;
    const start = Math.max(previousEnd, group[0].start - LEAD_SECONDS);
    const spoken = Math.min(next - LEAD_SECONDS, group.at(-1)!.end + LINGER_SECONDS);
    const end = Math.max(spoken, Math.min(next - LEAD_SECONDS, start + MIN_CAPTION_SECONDS), start + 0.1);
    const startTicks = snapTicks(secondsToTicks(start), fps);
    const endTicks = Math.max(startTicks + 1, snapTicks(secondsToTicks(end), fps));
    previousEnd = ticksToSeconds(endTicks);
    captions.push({
      id: uuidv4(),
      start: startTicks,
      duration: endTicks - startTicks,
      text: layoutLines(group, lineLength),
    });
  });
  return captions;
};

export const captionLimits = (items: Array<Caption>, id: string) => {
  const sorted = sortedCaptions(items);
  const index = sorted.findIndex((caption) => caption.id === id);
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  return {
    earliest: previous ? previous.start + previous.duration : 0,
    latest: next ? next.start : Number.POSITIVE_INFINITY,
  };
};

export const splitCaption = (items: Array<Caption>, id: string, time: Ticks, minimum: Ticks): Array<Caption> => {
  const caption = items.find((item) => item.id === id);
  if (!caption || time - caption.start < minimum || caption.start + caption.duration - time < minimum) return items;
  const words = caption.text.split(/\s+/).filter(Boolean);
  const cut = Math.min(
    words.length - 1,
    Math.max(1, Math.round((words.length * (time - caption.start)) / caption.duration)),
  );
  const head = words.length > 1 ? words.slice(0, cut).join(' ') : caption.text;
  const tail = words.length > 1 ? words.slice(cut).join(' ') : caption.text;
  return items.flatMap((item) =>
    item.id === id
      ? [
          { ...item, duration: time - item.start, text: head },
          { id: uuidv4(), start: time, duration: item.start + item.duration - time, text: tail },
        ]
      : [item],
  );
};

export const mergeWithNext = (items: Array<Caption>, id: string): Array<Caption> => {
  const sorted = sortedCaptions(items);
  const index = sorted.findIndex((caption) => caption.id === id);
  const next = sorted[index + 1];
  if (index < 0 || !next) return items;
  const caption = sorted[index];
  const merged = {
    ...caption,
    duration: next.start + next.duration - caption.start,
    text: `${caption.text} ${next.text}`.replace(/\s+/g, ' ').trim(),
  };
  return sorted.filter((item) => item.id !== next.id).map((item) => (item.id === id ? merged : item));
};
