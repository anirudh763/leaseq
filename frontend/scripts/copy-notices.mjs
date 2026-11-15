import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../leaseq/console/THIRD-PARTY-NOTICES.txt');
await mkdir(dirname(target), { recursive: true });
const notices = [];
for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react', 'tailwindcss']) {
  const folder = resolve(here, '../node_modules', name);
  const pkg = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  const license = await readFile(resolve(folder, 'LICENSE'), 'utf8');
  notices.push(`${name} ${pkg.version} (${pkg.license})\n\n${license}`);
}
await writeFile(target, notices.join('\n\n----------------\n\n'));
const fontDir = resolve(here, '../src/fonts');
await mkdir(fontDir, { recursive: true });
const publicDir = resolve(here, '../public');
await mkdir(publicDir, { recursive: true });
await copyFile(resolve(here, '../../leaseq/dashboard/assets/favicon.svg'), resolve(publicDir, 'favicon.svg'));
for (const file of ['atkinson-hyperlegible-latin-400-normal.woff2', 'atkinson-hyperlegible-latin-700-normal.woff2']) {
  await copyFile(resolve(here, `../../leaseq/dashboard/assets/${file}`), resolve(fontDir, file));
}
const license = resolve(here, '../../leaseq/console/fonts/OFL.txt');
await mkdir(dirname(license), { recursive: true });
await copyFile(resolve(here, '../../leaseq/dashboard/assets/OFL.txt'), license);
