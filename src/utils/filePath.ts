export function getDirectoryPath(filePath: string) {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));

  if (separatorIndex < 0) return '.';
  if (separatorIndex === 0) return filePath[0];

  const directoryPath = filePath.slice(0, separatorIndex);
  return /^[A-Za-z]:$/.test(directoryPath) ? `${directoryPath}${filePath[separatorIndex]}` : directoryPath;
}

function trimTrailingSeparators(filePath: string) {
  if (filePath === '/' || /^[A-Za-z]:[\\/]$/.test(filePath)) return filePath;
  return filePath.replace(/[\\/]+$/, '');
}

function normalizeForComparison(filePath: string) {
  const normalizedPath = trimTrailingSeparators(filePath).replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath;
}

export function getLibraryDisplayPath(filePath: string, rootPaths: string[]) {
  const directoryPath = getDirectoryPath(filePath);
  const directoryPathWithSlashes = trimTrailingSeparators(directoryPath).replace(/\\/g, '/');
  const normalizedDirectoryPath = normalizeForComparison(directoryPath);

  const matchingRoot = rootPaths
    .map((rootPath) => {
      const trimmedPath = trimTrailingSeparators(rootPath);
      return { path: trimmedPath, normalizedPath: normalizeForComparison(trimmedPath) };
    })
    .filter(
      (rootPath) =>
        normalizedDirectoryPath === rootPath.normalizedPath ||
        normalizedDirectoryPath.startsWith(`${rootPath.normalizedPath}/`),
    )
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)[0];

  if (!matchingRoot) return directoryPath;

  const rootName = matchingRoot.path.split(/[\\/]/).pop();
  if (!rootName) return directoryPath;

  const relativePath = directoryPathWithSlashes.slice(matchingRoot.normalizedPath.length).replace(/^\/+/, '');
  if (!relativePath) return rootName;

  const separator = matchingRoot.path.includes('\\') ? '\\' : '/';
  return `${rootName}${separator}${relativePath.replace(/\//g, separator)}`;
}
