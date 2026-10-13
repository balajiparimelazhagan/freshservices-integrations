import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'app/scripts/view.js'],
      reportsDirectory: 'coverage/unit',
      reporter: ['json', 'text']
    }
  }
});
