import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Isolates tests from the developer's real ~/.creditkarma-mcp/session.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
})
