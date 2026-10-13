export default [
  {
    files: ['**/*.{ts,mts,js,mjs}'],
    ignores: ['dist/**', 'node_modules/**', 'artifacts/**'],
    rules: {
      'no-console': 'off'
    }
  }
];
