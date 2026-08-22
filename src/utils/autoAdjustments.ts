export const AUTO_ADJUST_CONFIRMATION_THRESHOLD = 10;

interface EditedImageReference {
  is_edited?: boolean;
  path: string;
}

interface AutoAdjustTargetContext {
  activeView: string;
  explicitPaths?: string[];
  libraryActivePath: string | null;
  multiSelectedPaths: string[];
  selectedImagePath: string | null;
}

export const resolveAutoAdjustTargets = ({
  activeView,
  explicitPaths,
  libraryActivePath,
  multiSelectedPaths,
  selectedImagePath,
}: AutoAdjustTargetContext): string[] => {
  const unique = (paths: string[]) => [...new Set(paths.filter(Boolean))];

  if (explicitPaths?.length) return unique(explicitPaths);

  if (activeView === 'editor') {
    if (!selectedImagePath) return [];
    if (multiSelectedPaths.length > 1 && multiSelectedPaths.includes(selectedImagePath)) {
      return unique(multiSelectedPaths);
    }
    return [selectedImagePath];
  }

  if (multiSelectedPaths.length > 0) return unique(multiSelectedPaths);
  return libraryActivePath ? [libraryActivePath] : [];
};

export const countEditedAutoAdjustTargets = (
  paths: string[],
  imageList: EditedImageReference[],
  selectedImage?: EditedImageReference | null,
): number => {
  const editedPaths = new Set(imageList.filter((image) => image.is_edited).map((image) => image.path));
  if (selectedImage?.is_edited) editedPaths.add(selectedImage.path);
  return paths.filter((path) => editedPaths.has(path)).length;
};

export const shouldConfirmAutoAdjust = (targetCount: number, editedTargetCount: number): boolean =>
  targetCount >= AUTO_ADJUST_CONFIRMATION_THRESHOLD || (targetCount > 1 && editedTargetCount > 0);
