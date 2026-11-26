export const formatFocalLength = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return '';
  return text.endsWith('mm') ? text : `${text} mm`;
};
