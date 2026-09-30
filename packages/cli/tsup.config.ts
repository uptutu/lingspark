import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { lingspark: 'src/lingspark.ts' },
  // CommonJS, deliberately. Node's single-executable-application format only
  // runs a CJS entry point -- an ESM main is accepted by --experimental-sea-config
  // but fails at runtime ("Failed to load the ES module"). Verified on Node 24,
  // see DECISIONS.md D-006. The sources stay ESM; only this bundle is CJS.
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node22',
  platform: 'node',
  // Single file: @lingspark/* is bundled in so the hook binary resolves nothing
  // from disk at startup.
  noExternal: [/^@lingspark\//],
  bundle: true,
  dts: false,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
