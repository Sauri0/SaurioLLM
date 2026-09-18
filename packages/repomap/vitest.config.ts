// Config vitest de @saurio/repomap (doc 02 §5): se salta si no hay grammars en resources/grammars.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@saurio/repomap',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
