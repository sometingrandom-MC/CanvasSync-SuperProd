// Builds the plugin into dist/ (load this folder in Super Productivity) and
// packs the same files into release/canvas-sync-<version>.zip.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const release = join(root, 'release');
const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/plugin.ts')],
  outfile: join(dist, 'plugin.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  // Readable output: you can see exactly what runs in your app.
  minify: false,
  legalComments: 'none',
  banner: { js: `// Canvas Assignments v${manifest.version} for Super Productivity. Built from src/ — edit there.` },
  logLevel: 'info',
});

copyFileSync(join(root, 'src/manifest.json'), join(dist, 'manifest.json'));
copyFileSync(join(root, 'src/icon.svg'), join(dist, 'icon.svg'));

mkdirSync(release, { recursive: true });
const zipPath = join(release, `canvas-sync-${manifest.version}.zip`);
rmSync(zipPath, { force: true });
// -X: no extra file attributes, so rebuilding unchanged sources gives the same zip.
execFileSync('zip', ['-X', zipPath, 'manifest.json', 'plugin.js', 'icon.svg'], {
  cwd: dist,
  stdio: 'inherit',
});
console.log(`Built dist/ and ${zipPath.replace(root + '/', '')}`);
