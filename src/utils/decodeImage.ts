const recentlyDecoded: HTMLImageElement[] = [];
const MAX_RETAINED = 4;

export function decodeImage(url: string | null | undefined, timeoutMs = 150): Promise<void> {
  if (!url) return Promise.resolve();

  const img = new Image();
  img.decoding = 'async';
  img.src = url;

  recentlyDecoded.push(img);
  if (recentlyDecoded.length > MAX_RETAINED) recentlyDecoded.shift();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const decoded = img.decode().catch(() => {});

  return Promise.race([decoded, timeout]).finally(() => clearTimeout(timer));
}
