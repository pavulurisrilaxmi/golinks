import { resolve } from 'node:path';
import { DEFAULT_SELF_HOSTS } from '../core/destination.js';
import { createJsonFileRepository } from '../core/repository.js';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const STORE_PATH = resolve(process.env.GOLINKS_STORE ?? 'data/shortcuts.json');
// Extra hostnames this service answers on (comma-separated), so a shortcut
// cannot be pointed back at it. The request's own Host header is always checked.
const SELF_HOSTS = new Set([
  ...DEFAULT_SELF_HOSTS,
  ...(process.env.GOLINKS_SELF_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
]);
const ALLOW_PRIVATE = process.env.GOLINKS_ALLOW_PRIVATE_DESTINATIONS === 'true';

const start = async (): Promise<void> => {
  const repository = await createJsonFileRepository(STORE_PATH);
  const app = await buildApp({
    repository,
    policy: { selfHosts: SELF_HOSTS, allowPrivateAddresses: ALLOW_PRIVATE },
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: HOST });
  app.log.info(
    { store: STORE_PATH, selfHosts: [...SELF_HOSTS], allowPrivateDestinations: ALLOW_PRIVATE },
    'shortcut store ready',
  );
};

start().catch((error: unknown) => {
  console.error('Failed to start golinks:', error);
  process.exit(1);
});
