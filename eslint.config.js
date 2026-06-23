import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// Lean flat config — mirrors narrator-request / narratorr (no-explicit-any,
// type-imports, layering guards) without type-checked rules or custom plugins.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/coverage/**',
      '**/.earwitness/**',
      '**/.reviews/**',
      '**/scratch/**',
      '**/audit-reports/**',
      '**/.claude/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },

  // React client files
  {
    files: ['**/src/client/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Server code may log freely.
  {
    files: ['**/src/server/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Layering guards — client must not import server or fastify.
  {
    files: ['**/src/client/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/server/**', '**/server/*'],
        paths: [{ name: 'fastify', message: 'fastify must not be imported from client code.' }],
      }],
    },
  },
  // Shared must not import core/server (it's the leaf both depend on).
  {
    files: ['**/src/shared/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/core/**', '**/core/*', '**/server/**', '**/server/*', '@core/**', '@core/*', '@/**'],
      }],
    },
  },

  // Shared rules
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-useless-escape': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Tests — relax noise.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
