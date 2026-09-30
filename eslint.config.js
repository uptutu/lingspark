import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/generated/**',
      // Gitignored scratch space: a browser profile or a downloaded toolchain
      // parked there is third-party code, not ours to lint.
      '.lingspark-scratch/**',
      '**/*.config.ts',
      '**/*.config.js',
    ],
  },

  js.configs.recommended,

  // Plain Node scripts (build steps, probes). Linted, but not type-aware:
  // they are outside every tsconfig on purpose.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // TypeScript sources and tests, with type-aware rules.
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Classic project mode: the root tsconfig covers sources *and* tests,
        // which the per-package build tsconfigs deliberately exclude.
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Section 13: no `any` unless the reason is written down.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
