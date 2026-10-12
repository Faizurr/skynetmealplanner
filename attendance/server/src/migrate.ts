import { migrate } from './db.js';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set MIGRATION_DATABASE_URL (owner role) or DATABASE_URL');
  process.exit(1);
}
const applied = await migrate(url, process.env.DATABASE_SSL === 'true', process.env.APP_DB_ROLE);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
