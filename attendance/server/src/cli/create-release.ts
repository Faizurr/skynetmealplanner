/**
 * Publishes an Android kiosk release record (platform operator task, not per-tenant).
 *   npm run create-release -- --apk ./app-release.apk --url https://downloads.example.com/kiosk-1.2.0.apk \
 *       --version-code 12 --version-name 1.2.0 --cert-sha256 <hex> [--min 10] [--notes "..."]
 * The APK SHA-256 is computed from the local file so it always matches what you upload.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values } = parseArgs({
  options: {
    apk: { type: 'string' }, url: { type: 'string' }, 'version-code': { type: 'string' }, 'version-name': { type: 'string' },
    'cert-sha256': { type: 'string' }, min: { type: 'string' }, notes: { type: 'string', default: '' },
  },
});
for (const k of ['apk', 'url', 'version-code', 'version-name', 'cert-sha256'] as const) {
  if (!values[k]) { console.error(`--${k} is required`); process.exit(1); }
}
if (!values.url!.startsWith('https://')) { console.error('--url must be https://'); process.exit(1); }
const sha = createHash('sha256').update(await readFile(values.apk!)).digest('hex');
const cert = values['cert-sha256']!.toLowerCase().replace(/[^0-9a-f]/g, '');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
await client.connect();
await client.query(
  `INSERT INTO app_releases (platform, version_code, version_name, apk_url, apk_sha256, signing_cert_sha256, min_supported_version_code, release_notes)
   VALUES ('android', $1, $2, $3, $4, $5, $6, $7)`,
  [Number(values['version-code']), values['version-name'], values.url, sha, cert, Number(values.min ?? 1), values.notes],
);
await client.end();
console.log(`Published android ${values['version-name']} (${values['version-code']}) sha256=${sha}`);
