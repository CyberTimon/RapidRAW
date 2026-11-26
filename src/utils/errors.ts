import { createElement } from 'react';
import i18n, { type ParseKeys } from 'i18next';
import { toast, type Id } from 'react-toastify';
import ActionToast from '../components/ui/ActionToast';

const MAX_DETAIL_LENGTH = 160;
const ACTION_TOAST_MS = 10000;

const CAUSES: Array<[RegExp, ParseKeys]> = [
  [
    /out of (gpu |video |device )?memory|outofmemory|e_outofmemory|cuda_error_out_of_memory/i,
    'ui.errors.causes.gpuMemory',
  ],
  [/os error (5|13)\b|permission denied|access is denied|eacces|eperm/i, 'ui.errors.causes.permission'],
  [/os error 3\b|cannot find the path specified|path not found|enotdir/i, 'ui.errors.causes.missingFolder'],
  [
    /os error 2\b|no such file|does not exist|cannot find the file specified|file not found|enoent/i,
    'ui.errors.causes.missingFile',
  ],
  [/os error (39|112)\b|no space left|not enough space on the disk|enospc/i, 'ui.errors.causes.diskFull'],
  [
    /offline|no internet|network is unreachable|dns error|failed to fetch|error sending request|connection (refused|reset)|os error (10051|10060|10061|11001)\b/i,
    'ui.errors.causes.offline',
  ],
];

export class KnownError extends Error {}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const errorCause = (error: unknown) => {
  if (error instanceof KnownError) return error.message;
  const text = errorText(error);
  const cause = CAUSES.find(([pattern]) => pattern.test(text));
  return cause ? i18n.t(cause[1]) : null;
};

export const errorReason = (error: unknown) => {
  const cause = errorCause(error);
  if (cause) return cause;
  const line = errorText(error).split('\n')[0].trim();
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH - 1)}…` : line;
};

interface ErrorOptions {
  retry?: () => void;
  values?: Record<string, unknown>;
  id?: string;
}

const shownErrors = new Map<string, Id>();

export const showError = (key: ParseKeys, error: unknown, { retry, values, id = key }: ErrorOptions = {}) => {
  if (error !== null) console.error(error);
  const content = createElement(ActionToast, {
    message: String(i18n.t(key, values)),
    detail: error === null ? null : errorCause(error),
    action: retry ? i18n.t('ui.errors.retry') : undefined,
    onAction: retry
      ? () => {
          toast.dismiss(shownErrors.get(id));
          retry();
        }
      : undefined,
  });
  const options = { autoClose: retry ? ACTION_TOAST_MS : undefined, closeOnClick: !retry };
  const shown = shownErrors.get(id);
  if (shown !== undefined && toast.isActive(shown)) toast.update(shown, { ...options, render: content });
  else shownErrors.set(id, toast.error(content, options));
};
