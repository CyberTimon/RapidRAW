export const DEFAULT_CONVERTED_INPUT_EXTENSIONS = ['heic', 'heif', 'hif'];
export const CONVERTED_INPUT_DISCLOSURE_VERSION = 1;

function physicalPath(path: string): string {
  return path.split('?vc=')[0];
}

export function fileExtension(path: string): string {
  const filename = physicalPath(path).split(/[\\/]/).pop() || '';
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex > 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';
}

export function requiresConvertedInputDisclosure(
  paths: string[],
  configuredExtensions: string[] | undefined,
  osPlatform: string | undefined,
  acknowledgedVersion: number,
): boolean {
  if (acknowledgedVersion >= CONVERTED_INPUT_DISCLOSURE_VERSION) return false;

  const convertedExtensions = new Set(
    (configuredExtensions ?? (osPlatform === 'macos' ? DEFAULT_CONVERTED_INPUT_EXTENSIONS : [])).map((extension) =>
      extension.toLowerCase(),
    ),
  );
  return paths.some((path) => convertedExtensions.has(fileExtension(path)));
}
