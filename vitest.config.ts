import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // No test may reach the network; backends are exercised through the mock
    // judge and replay fixtures only (design doc, section 13).
    globals: false,
  },
});
