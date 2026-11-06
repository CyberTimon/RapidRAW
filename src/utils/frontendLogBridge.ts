import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';

type FrontendLogLevel = 'debug' | 'info' | 'warn' | 'error';

type ConsoleMethod = (...args: unknown[]) => void;

const MAX_LOG_MESSAGE_LENGTH = 12000;
const MAX_SERIALIZE_DEPTH = 5;
const DEDUPE_WINDOW_MS = 1500;
const CONSOLE_LEVEL_MAP: Array<[keyof Console, FrontendLogLevel]> = [
  ['debug', 'debug'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
  ['log', 'info'],
];

const originalConsole = new Map<keyof Console, ConsoleMethod>();
const recentLogMap = new Map<string, number>();
let isInstalled = false;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRecordField<T>(record: Record<string, unknown>, key: string): T | undefined {
  return record[key] as T | undefined;
}

function isViteLikeError(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return false;
  }

  return Boolean(
    getRecordField<string>(value, 'message') ||
      getRecordField<string>(value, 'stack') ||
      getRecordField<string>(value, 'frame') ||
      getRecordField<string>(value, 'plugin') ||
      getRecordField<string>(value, 'id') ||
      getRecordField<Record<string, unknown>>(value, 'loc'),
  );
}

function formatViteErrorDetails(value: Record<string, unknown>): string {
  const lines: string[] = [];
  const message = getRecordField<string>(value, 'message');
  const plugin = getRecordField<string>(value, 'plugin');
  const id = getRecordField<string>(value, 'id');
  const stack = getRecordField<string>(value, 'stack');
  const frame = getRecordField<string>(value, 'frame');
  const loc = getRecordField<Record<string, unknown>>(value, 'loc');

  if (message) {
    lines.push(`[vite:error] ${message}`);
  }
  if (plugin) {
    lines.push(`[vite:error] plugin: ${plugin}`);
  }
  if (id) {
    lines.push(`[vite:error] file: ${id}`);
  }
  if (isPlainRecord(loc)) {
    const file = getRecordField<string>(loc, 'file');
    const line = getRecordField<number>(loc, 'line');
    const column = getRecordField<number>(loc, 'column');
    const locParts = [file, line, column].filter((part) => part !== undefined && part !== null);
    if (locParts.length > 0) {
      lines.push(`[vite:error] loc: ${locParts.join(':')}`);
    }
  }
  if (frame && frame.trim()) {
    lines.push(`[vite:error] frame:\n${frame.trim()}`);
  }
  if (stack && stack.trim()) {
    lines.push(`[vite:error] stack:\n${stack.trim()}`);
  }

  return lines.join('\n');
}

function extractViteDetails(args: unknown[]): string | null {
  const hasVitePrefix = args.some((arg) => typeof arg === 'string' && arg.includes('[vite]'));
  const candidate = args.find(isViteLikeError);

  if (!hasVitePrefix && !candidate) {
    return null;
  }

  if (candidate) {
    const details = formatViteErrorDetails(candidate);
    if (details) {
      return details;
    }
  }

  return null;
}

function shouldIgnoreMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('[vite] failed to reload') &&
    normalized.includes('see errors above')
  ) {
    return true;
  }

  return false;
}

function shouldDropDuplicate(level: FrontendLogLevel, message: string): boolean {
  const now = Date.now();
  for (const [key, ts] of recentLogMap) {
    if (now - ts > DEDUPE_WINDOW_MS) {
      recentLogMap.delete(key);
    }
  }

  const dedupeKey = `${level}:${message}`;
  const previousTs = recentLogMap.get(dedupeKey);
  if (previousTs && now - previousTs <= DEDUPE_WINDOW_MS) {
    return true;
  }

  recentLogMap.set(dedupeKey, now);
  return false;
}

function serializeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return '[MaxDepth]';
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: serializeValue((value as Error & { cause?: unknown }).cause, depth + 1, seen),
      ...Object.fromEntries(
        Object.getOwnPropertyNames(value).map((key) => [
          key,
          serializeValue((value as unknown as Record<string, unknown>)[key], depth + 1, seen),
        ]),
      ),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, depth + 1, seen));
  }

  if (value instanceof Event) {
    const eventRecord: Record<string, unknown> = {
      type: value.type,
    };

    for (const key of Object.getOwnPropertyNames(value)) {
      eventRecord[key] = serializeValue(
        (value as unknown as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }

    return eventRecord;
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const output: Record<string, unknown> = {};
    const keys = new Set<string>([
      ...Object.keys(value),
      ...Object.getOwnPropertyNames(value),
    ]);
    for (const key of keys) {
      output[key] = serializeValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
    return output;
  }

  if (typeof value === 'function') {
    return `[Function ${(value as Function).name || 'anonymous'}]`;
  }

  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }

  return value;
}

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return JSON.stringify(serializeValue(value, 0, new WeakSet()));
  }

  try {
    return JSON.stringify(serializeValue(value, 0, new WeakSet()));
  } catch {
    return String(value);
  }
}

function formatLogMessage(args: unknown[]): string {
  const baseMessage = args.map(stringifyArg).join(' ');
  const viteDetails = extractViteDetails(args);
  const message = viteDetails ? `${baseMessage}\n${viteDetails}` : baseMessage;

  if (message.length <= MAX_LOG_MESSAGE_LENGTH) {
    return message;
  }

  return `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}… [truncated]`;
}

function sendToBackend(level: FrontendLogLevel, args: unknown[]): void {
  const message = formatLogMessage(args);
  if (!message || shouldIgnoreMessage(message) || shouldDropDuplicate(level, message)) {
    return;
  }

  void invoke(Invokes.FrontendLog, {
    level,
    message,
  }).catch(() => {
    // Prevent recursion if backend logging channel is unavailable.
  });
}

export function installFrontendLogBridge(): void {
  if (isInstalled || typeof window === 'undefined') {
    return;
  }
  isInstalled = true;

  for (const [methodName, level] of CONSOLE_LEVEL_MAP) {
    const original = console[methodName];
    if (typeof original !== 'function') {
      continue;
    }

    const typedOriginal = original.bind(console) as ConsoleMethod;
    originalConsole.set(methodName, typedOriginal);

    (console[methodName] as ConsoleMethod) = (...args: unknown[]) => {
      typedOriginal(...args);
      sendToBackend(level, args);
    };
  }

  window.addEventListener('error', (event) => {
    const payload: unknown[] = [
      event.message || 'Unhandled window error',
      event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : undefined,
      event.error ?? undefined,
      {
        type: event.type,
        timeStamp: event.timeStamp,
      },
    ].filter(Boolean);

    sendToBackend('error', payload);
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendToBackend('error', ['Unhandled promise rejection', event.reason]);
  });

  const hot = (import.meta as ImportMeta & { hot?: { on: (event: string, cb: (payload: unknown) => void) => void } })
    .hot;
  if (hot?.on) {
    hot.on('vite:error', (payload: unknown) => {
      const err = isPlainRecord(payload) ? getRecordField<unknown>(payload, 'err') ?? payload : payload;
      sendToBackend('error', ['[vite:error:event]', err]);
    });
  }
}
