export function verticalTarget(rows: string[][], path: string | null, direction: number): string | null {
  const row = rows.findIndex((items) => path !== null && items.includes(path));
  if (row < 0) return rows[0]?.[0] ?? null;
  const column = rows[row].indexOf(path!);
  const target = rows[Math.max(0, Math.min(rows.length - 1, row + direction))];
  return target[Math.min(column, target.length - 1)] ?? path;
}
