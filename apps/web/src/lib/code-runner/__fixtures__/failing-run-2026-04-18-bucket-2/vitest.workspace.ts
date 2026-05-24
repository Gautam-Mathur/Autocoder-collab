// Bucket 2 — defineWorkspaceProject helper, same call-block shape.
// (Stored under a vitest.config-named file because the doctor rule keys
// on the file name; the callee allowlist still applies.)
import { defineWorkspaceProject } from 'vitest/config';

export default defineWorkspaceProject() {
  test: {
    name: 'unit',
    include: ['src/**/*.test.ts'],
  },
}
