import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ApiError, GoLinksClient } from '../src/cli/client.js';
import { renderTable } from '../src/cli/format.js';
import { run } from '../src/cli/index.js';
import { InMemoryShortcutRepository } from '../src/core/repository.js';
import { buildApp } from '../src/server/app.js';

// The CLI talks HTTP, so it is tested against a real listening server on an
// ephemeral port rather than against mocked fetch — the contract under test is
// the wire format, and mocks would only prove the CLI agrees with itself.
let app: FastifyInstance;
let client: GoLinksClient;
let out: string[];
let err: string[];

beforeAll(async () => {
  app = await buildApp({ repository: new InMemoryShortcutRepository(), logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  client = new GoLinksClient(address);
});

afterAll(async () => {
  await app.close();
});

const captureOutput = () => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void err.push(args.join(' ')));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('go', () => {
  test('creates, lists, shows, resolves and removes a shortcut', async () => {
    captureOutput();

    expect(await run(['new', 'oncall', 'https://pager.internal/rota'], client)).toBe(0);
    expect(out.at(-1)).toBe('Created /oncall -> https://pager.internal/rota');

    expect(await run(['ls'], client)).toBe(0);
    expect(out.at(-1)).toContain('/oncall');
    expect(out.at(-1)).toContain('never');

    expect(await run(['ls', '--json'], client)).toBe(0);
    expect(JSON.parse(out.at(-1) ?? '')).toHaveLength(1);

    expect(await run(['open', 'oncall', '--print'], client)).toBe(0);
    expect(out.at(-1)).toBe('https://pager.internal/rota');

    expect(await run(['get', 'oncall', '--json'], client)).toBe(0);
    expect(JSON.parse(out.at(-1) ?? '').slug).toBe('oncall');

    expect(await run(['edit', 'oncall', 'https://pager.internal/v2', '--description', 'moved'], client)).toBe(0);
    expect(out.at(-1)).toBe('Updated /oncall -> https://pager.internal/v2');
    expect(await run(['get', 'oncall', '--json'], client)).toBe(0);
    expect(JSON.parse(out.at(-1) ?? '')).toMatchObject({ url: 'https://pager.internal/v2', description: 'moved' });

    expect(await run(['rm', 'oncall'], client)).toBe(0);
    expect(out.at(-1)).toBe('Deleted /oncall');
  });

  test('surfaces server validation as a typed error with field detail', async () => {
    captureOutput();

    await expect(run(['new', 'api', 'nope'], client)).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      issues: [
        { field: 'slug', message: expect.stringContaining('reserved') },
        { field: 'url', message: expect.any(String) },
      ],
    } satisfies Partial<ApiError>);
  });

  test('exits 2 with usage when the command line is wrong', async () => {
    captureOutput();

    expect(await run(['new', 'only-a-slug'], client)).toBe(2);
    expect(await run(['edit', 'oncall'], client)).toBe(2);
    expect(err.at(-1)).toContain('Usage:');

    expect(await run(['nonsense'], client)).toBe(2);
    expect(await run([], client)).toBe(2);
    expect(await run(['--help'], client)).toBe(0);
  });

  test('records the CLI identity as the creator', async () => {
    captureOutput();
    const alice = new GoLinksClient(client['baseUrl' as keyof GoLinksClient] as unknown as string, 'alice');

    expect(await run(['new', 'owned', 'https://x.internal'], alice)).toBe(0);
    expect(await run(['get', 'owned', '--json'], alice)).toBe(0);
    expect(JSON.parse(out.at(-1) ?? '').createdBy).toBe('alice');
  });

  test('renders an aligned table for humans', () => {
    const table = renderTable([
      {
        slug: 'oncall',
        url: 'https://pager.internal/rota',
        description: null,
        createdBy: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        hits: 14,
        lastAccessedAt: new Date(Date.now() - 90_000).toISOString(),
      },
    ]);

    expect(table.split('\n')[0]).toMatch(/^SHORTCUT\s+DESTINATION\s+HITS\s+LAST USED$/);
    expect(table.split('\n')[1]).toMatch(/^\/oncall\s+https:\/\/pager\.internal\/rota\s+14\s+2m ago$/);
  });
});
