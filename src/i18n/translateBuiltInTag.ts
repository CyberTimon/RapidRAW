import i18n from 'i18next';

const BUILT_IN_TAG_KEYS = {
  architecture: 'ui.builtInTags.architecture',
  event: 'ui.builtInTags.event',
  family: 'ui.builtInTags.family',
  food: 'ui.builtInTags.food',
  landscape: 'ui.builtInTags.landscape',
  nature: 'ui.builtInTags.nature',
  portrait: 'ui.builtInTags.portrait',
  street: 'ui.builtInTags.street',
  travel: 'ui.builtInTags.travel',
} as const;

export function translateBuiltInTag(tag: string): string {
  const normalizedTag = tag.trim().toLowerCase() as keyof typeof BUILT_IN_TAG_KEYS;
  const translationKey = BUILT_IN_TAG_KEYS[normalizedTag];
  return translationKey ? String(i18n.t(translationKey)) : tag;
}
