import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ConflictError, NotFoundError } from '../src/core/errors.js';
import { createJsonFileRepository, InMemoryShortcutRepository } from '../src/core/repository.js';
import type { Shortcut } from '../src/core/shortcut.js';

const input = (slug: string, url = 'https://example.internal') => ({
  slug,
  url,
  description: null,
});

describe('InMemoryShortcutRepository', () => {
  test('creates and finds a shortcut regardless of slug casing', async () => {
    const repository = new InMemoryShortcutRepository();
    await repository.create(input('oncall'));

    expect(await repository.find('OnCall')).toMatchObject({ slug: 'oncall', hits: 0 });
  });

  test('records who created a shortcut', async () => {
    const repository = new InMemoryShortcutRepository();
    await repository.create(input('oncall'), 'alice');
    expect((await repository.find('oncall'))?.createdBy).toBe('alice');
  });

  test('updates url and description independently and bumps updatedAt', async () => {
    const repository = new InMemoryShortcutRepository();
    const created = await repository.create({ ...input('oncall'), description: 'old' });

    const afterUrl = await repository.update('oncall', { url: 'https://new.internal', description: undefined });
    expect(afterUrl).toMatchObject({ url: 'https://new.internal', description: 'old' });
    expect(afterUrl.updatedAt >= created.updatedAt).toBe(true);

    const afterClear = await repository.update('oncall', { description: null });
    expect(afterClear).toMatchObject({ url: 'https://new.internal', description: null });

    await expect(repository.update('ghost', { url: 'https://x.internal' })).rejects.toThrow(NotFoundError);
  });

  test('refuses to overwrite an existing slug', async () => {
    const repository = new InMemoryShortcutRepository();
    await repository.create(input('oncall'));

    await expect(repository.create(input('oncall'))).rejects.toThrow(ConflictError);
  });

  test('filters by slug, URL and description', async () => {
    const repository = new InMemoryShortcutRepository();
    await repository.create(input('payroll', 'https://finance.internal/pay'));
    await repository.create({ ...input('design'), description: 'Design system docs' });

    expect(await repository.list('finance')).toHaveLength(1);
    expect(await repository.list('design system')).toHaveLength(1);
    expect(await repository.list('design')).toHaveLength(1);
    expect(await repository.list('nothing-matches')).toHaveLength(0);
    expect(await repository.list()).toHaveLength(2);
  });

  test('orders the list by hits so popular shortcuts surface first', async () => {
    const repository = new InMemoryShortcutRepository();
    await repository.create(input('quiet'));
    await repository.create(input('busy'));
    await repository.recordHit('busy');

    expect((await repository.list()).map((shortcut) => shortcut.slug)).toEqual(['busy', 'quiet']);
  });

  test('stamps lastAccessedAt on the first hit and leaves it null before', async () => {
    const repository = new InMemoryShortcutRepository();
    await repository.create(input('oncall'));
    expect((await repository.find('oncall'))?.lastAccessedAt).toBeNull();

    await repository.recordHit('oncall');
    const after = await repository.find('oncall');
    expect(after?.hits).toBe(1);
    expect(Date.parse(after?.lastAccessedAt ?? '')).not.toBeNaN();
  });

  test('ignores hits for slugs that do not exist', async () => {
    const repository = new InMemoryShortcutRepository();
    await expect(repository.recordHit('ghost')).resolves.toBeUndefined();
  });

  test('raises NotFoundError when requiring or removing a missing slug', async () => {
    const repository = new InMemoryShortcutRepository();

    await expect(repository.require('ghost')).rejects.toThrow(NotFoundError);
    await expect(repository.remove('ghost')).rejects.toThrow(NotFoundError);
  });
});

describe('createJsonFileRepository', () => {
  test('persists shortcuts across restarts', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'golinks-')), 'shortcuts.json');

    const first = await createJsonFileRepository(path);
    await first.create(input('oncall'));

    const reopened = await createJsonFileRepository(path);
    expect(await reopened.find('oncall')).toMatchObject({ slug: 'oncall' });

    const onDisk: Shortcut[] = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk).toHaveLength(1);
  });

  test('upgrades a store written before lastAccessedAt existed', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'golinks-')), 'shortcuts.json');
    await writeFile(
      path,
      JSON.stringify([{ slug: 'old', url: 'https://x.internal', description: null, createdAt: 't', hits: 3 }]),
    );

    const repository = await createJsonFileRepository(path);
    expect(await repository.find('old')).toMatchObject({
      hits: 3,
      lastAccessedAt: null,
      createdBy: null,
      updatedAt: 't',
    });
  });

  test('starts empty when the store file does not exist yet', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'golinks-')), 'nested', 'shortcuts.json');

    const repository = await createJsonFileRepository(path);
    expect(await repository.list()).toEqual([]);
  });
});
