import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['scripts/**/*.ts'],
      // Thresholds are absolute so that untested code cannot land. Guards that
      // assert an invariant the callers already enforce are genuinely
      // unreachable; mark those with `/* v8 ignore */` and a comment saying why
      // rather than deleting the guard to satisfy the threshold.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
