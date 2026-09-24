export interface SettingsSearchItem<TCategory extends string = string> {
  category: TCategory;
  categoryLabel: string;
  description?: string;
  keywords?: string[];
  label: string;
}

export function normalizeSettingsSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}

export function filterSettingsSearchItems<TItem extends SettingsSearchItem>(items: TItem[], query: string): TItem[] {
  const normalizedQuery = normalizeSettingsSearchText(query);
  if (!normalizedQuery) return [];

  const queryTerms = normalizedQuery.split(/\s+/);

  return items.filter((item) => {
    const searchableText = normalizeSettingsSearchText(
      [item.label, item.description, item.categoryLabel, ...(item.keywords || [])].filter(Boolean).join(' '),
    );
    return queryTerms.every((term) => searchableText.includes(term));
  });
}
