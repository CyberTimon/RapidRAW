import type { Roll } from '../components/ui/AppProperties';

export type RollDetails = Omit<Roll, 'id' | 'number' | 'images'>;

export const formatRollNumber = (number: number): string => String(number).padStart(5, '0');

export const getRollTitle = (roll: Pick<Roll, 'number' | 'loadedOn' | 'camera' | 'filmStock'>): string =>
  `${roll.loadedOn} · ${roll.camera} · ${roll.filmStock} · ${formatRollNumber(roll.number)}`;

export const getRollPath = (roll: Pick<Roll, 'number' | 'loadedOn' | 'camera' | 'filmStock'>): string =>
  `Roll: ${getRollTitle(roll)}`;

export const isCollectionPath = (path: string | null | undefined): boolean =>
  !!path && (path.startsWith('Album: ') || path.startsWith('Roll: '));

export const getLocalDateString = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
