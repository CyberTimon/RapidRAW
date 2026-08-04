const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const react = require('eslint-plugin-react');
const i18next = require('eslint-plugin-i18next');

const tsFiles = ['**/*.{ts,tsx}'];
const noUnnecessaryConditionErrorFiles = ['src/hooks/useSortedLibrary.ts'];

const jsRecommendedForTs = {
  ...js.configs.recommended,
  files: tsFiles,
};

const tsRecommended = tseslint.configs.recommended.map((config) =>
  config.files ? config : { ...config, files: tsFiles },
);

module.exports = [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'src-tauri/rawler/**',
      'data/**',
    ],
  },
  jsRecommendedForTs,
  ...tsRecommended,
  {
    files: tsFiles,
    plugins: {
      react,
      i18next,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        projectService: {
          allowDefaultProject: ['i18next.config.ts'],
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'i18next/no-literal-string': [
        'warn',
        {
          markupOnly: true,
          ignoreAttribute: [
            'className',
            'style',
            'data-tooltip',
            'variant',
            'size',
            'color',
            'weight',
            'fillOrigin',
            'id',
            'name',
            'type',
            'value',
            'label',
            'placeholder',
            'stroke',
            'fill',
            'viewBox',
          ],
        },
      ],
    },
  },
  {
    files: noUnnecessaryConditionErrorFiles,
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
];
