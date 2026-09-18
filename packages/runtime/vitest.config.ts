// Config vitest de @saurio/runtime: paquete Node puro, se testea sin Electron (doc 02 §3, ADR-002).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@saurio/runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
