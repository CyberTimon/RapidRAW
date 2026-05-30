import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'src/i18n/locales/{{language}}.json',
    defaultNS: false,
    removeUnusedKeys: false,
    sort: true,
    defaultValue: '',
  },
});
