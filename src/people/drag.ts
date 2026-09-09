export const PERSON_DRAG = 'application/x-rapidraw-person-ids';
export const FACE_DRAG = 'application/x-rapidraw-face-ids';

export function writeDraggedIds(event: React.DragEvent, type: string, ids: string[]) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(type, JSON.stringify([...new Set(ids)]));
}

export function readDraggedIds(event: React.DragEvent, type: string) {
  try {
    const value = JSON.parse(event.dataTransfer.getData(type));
    return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : [];
  } catch {
    return [];
  }
}
