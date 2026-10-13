import { build, context } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

await mkdir(dist, { recursive: true });

const entries = {
  'background/index': path.join(root, 'src/background/index.ts'),
  'content/index': path.join(root, 'src/content/index.ts'),
  'options/index': path.join(root, 'src/options/index.ts')
};

const options = {
  entryPoints: entries,
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  sourcemap: true,
  logLevel: 'info'
};

async function copyStatic() {
  await cp(path.join(root, 'public'), dist, { recursive: true, force: true });
  const manifestPath = path.join(dist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = process.env.EXTENSION_VERSION ?? manifest.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching extension sources. Reload the unpacked extension after rebuilds.');
} else {
  await build(options);
}
