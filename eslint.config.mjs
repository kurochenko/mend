import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { noBarrelExport } from './scripts/eslint-rules/no-barrel-export.mjs'

const ignores = [
  '.beads/**',
  '.codex/**',
  '.opencode/**',
  '.skillbook/**',
  'coverage/**',
  'dist/**',
  'drizzle/**',
  'fixtures/**',
  'logs/**',
  'node_modules/**',
  'out/**',
  'sessions/**',
  'workspaces/**',
]

export default defineConfig(
  {
    ignores,
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.bun,
      },
    },
    plugins: {
      mend: {
        rules: {
          'no-barrel-export': noBarrelExport,
        },
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'warn',
      complexity: ['warn', { max: 12 }],
      curly: ['warn', 'all'],
      eqeqeq: ['warn', 'always'],
      'max-depth': ['warn', 4],
      'max-lines-per-function': [
        'warn',
        {
          max: 90,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      'max-params': ['warn', 4],
      'mend/no-barrel-export': 'error',
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.e2e.ts',
      '**/__tests__/**/*.ts',
      'tests/**/*.ts',
      '*.config.{js,mjs,cjs,ts}',
      'scripts/**/*.ts',
      'tools/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
      complexity: 'off',
      'max-depth': 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
    },
  },
)
