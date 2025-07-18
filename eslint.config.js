import js from '@eslint/js'
import reactPlugin from 'eslint-plugin-react'
import { FlatCompat } from '@eslint/eslintrc'
import { fileURLToPath, URL } from 'node:url'

export default [
  {
    ignores: [
      '**/.DS_Store',
      'node_modules/**',
      'dist/**',
      '**/*.css',
      '**/*.htm',
      '**/*.html',
      '**/*.json',
      '**/*.md',
      '**/*.markdown',
      '**/*.yml',
      '**/*.yaml'
    ]
  },
  {
    files: ['**/*.jsx', '**/*.js', '**/*.cjs', '**/*.mjs'],
    ...js.configs.recommended
  },

  {
    files: ['**/*.jsx', '**/*.js', '**/*.cjs', '**/*.mjs'],
    ...reactPlugin.configs.flat.recommended
  },
  {
    files: ['**/*.jsx', '**/*.js', '**/*.cjs', '**/*.mjs'],
    ...reactPlugin.configs.flat['jsx-runtime']
  },
  ...new FlatCompat({
    baseDirectory: fileURLToPath(new URL('.', import.meta.url))
  }).extends('eslint-config-standard')
    .map(config => ({
      ...config,
      files: ['**/*.jsx', '**/*.js', '**/*.cjs', '**/*.mjs']
    })),
  ...new FlatCompat({
    baseDirectory: fileURLToPath(new URL('.', import.meta.url))
  }).extends('eslint-config-standard-jsx')
    .map(config => ({
      ...config,
      files: ['**/*.jsx', '**/*.js', '**/*.cjs', '**/*.mjs']
    })),
  {
    files: ['**/*.jsx', '**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      'import/extensions': ['error', 'always', { ignorePackages: true }]
    }
  }
]
