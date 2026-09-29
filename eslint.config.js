import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['actions/merge-queue/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    ignores: ['coverage/**', 'node_modules/**'],
  },
]
