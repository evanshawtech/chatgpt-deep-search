import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.spec.ts'],
    coverage: {
      reporter: ['text', 'html']
    }
  }
});
