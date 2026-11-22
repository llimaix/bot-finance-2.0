#!/usr/bin/env node
/**
 * Empaqueta cada Lambda con esbuild (mismas opciones que usaba el CDK):
 *   dist/<función>/index.mjs  → código desplegable (handler: index.handler)
 *   dist/<función>/meta.json  → metafile: archivos exactos que entraron al bundle;
 *                               el pipeline lo cruza con los cambios del push para
 *                               desplegar solo las funciones afectadas.
 *
 * Uso (desde backend/): pnpm build
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const FUNCTIONS = {
  webhook: 'src/handlers/webhook.ts',
  processor: 'src/handlers/processor.ts',
  reminder: 'src/handlers/reminder.ts',
  'monthly-report': 'src/handlers/monthly-report.ts',
};

rmSync('dist', { recursive: true, force: true });

for (const [name, entry] of Object.entries(FUNCTIONS)) {
  const outdir = `dist/${name}`;
  mkdirSync(outdir, { recursive: true });

  const result = await build({
    entryPoints: [entry],
    outfile: `${outdir}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    minify: true,
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
    // Shim para dependencias que usan require() dentro del bundle ESM.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });

  writeFileSync(`${outdir}/meta.json`, JSON.stringify(result.metafile));
  const inputs = Object.keys(result.metafile.inputs).length;
  const bytes = result.metafile.outputs[`${outdir}/index.mjs`]?.bytes ?? 0;
  console.log(`${name}: ${inputs} archivos de entrada, ${(bytes / 1024).toFixed(0)} KiB`);
}
