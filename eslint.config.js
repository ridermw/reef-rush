import globals from 'globals';

export default [
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      '.superpowers',
      '.tmp-vite-template',
    ],
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
];
