import { defineConfig } from 'vitest/config';

/** Shared defaults; the two projects live in vitest.workspace.ts. */
export default defineConfig({
  test: {
    environment: 'node',
  },
});
