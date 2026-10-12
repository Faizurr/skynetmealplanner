// Generates the PWA icons from an inline SVG mark. Run: npm run icons
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
mkdirSync(out, { recursive: true });

// The mark: a clock face whose hand becomes a check — "on time, verified".
function mark({ size, radius, scale }) {
  const c = size / 2;
  const r = (size * 0.30) * scale;
  const sw = size * 0.055 * scale;
  const k = (v) => (c + v * scale * size).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#14161a"/>
  <circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="#f2f2ef" stroke-width="${sw.toFixed(2)}" opacity="0.92"/>
  <path d="M ${k(-0.135)} ${k(0.005)} L ${k(-0.035)} ${k(0.105)} L ${k(0.15)} ${k(-0.10)}" fill="none" stroke="#5b7cff" stroke-width="${(sw * 1.15).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

const jobs = [
  { file: 'icon-192.png', size: 192, radius: 40, scale: 1 },
  { file: 'icon-512.png', size: 512, radius: 108, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, scale: 0.78 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, scale: 0.9 },
];
for (const j of jobs) {
  await sharp(Buffer.from(mark(j))).png().toFile(path.join(out, j.file));
  console.log('wrote', j.file);
}
writeFileSync(path.join(out, 'favicon.svg'), mark({ size: 64, radius: 14, scale: 1 }));
console.log('wrote favicon.svg');
