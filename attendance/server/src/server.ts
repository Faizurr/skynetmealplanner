import { loadConfig } from './config.js';
import { migrate } from './db.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') {
  await migrate(cfg.MIGRATION_DATABASE_URL ?? cfg.DATABASE_URL, cfg.DATABASE_SSL, cfg.APP_DB_ROLE);
}
const built = await buildApp(cfg);
if (cfg.RUN_WORKER) built.worker.start();
await built.app.listen({ port: cfg.PORT, host: cfg.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    built.app.log.info(`${sig} received, shutting down`);
    await built.close().catch(() => {});
    process.exit(0);
  });
}
