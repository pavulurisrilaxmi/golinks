import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConflictError, NotFoundError } from './errors.js';
import {
  normaliseSlug,
  type CreateShortcutInput,
  type Shortcut,
  type UpdateShortcutInput,
} from './shortcut.js';

export interface ShortcutRepository {
  create(input: CreateShortcutInput, actor?: string | null): Promise<Shortcut>;
  /** Applies a partial change. Throws `NotFoundError` for an unknown slug. */
  update(slug: string, patch: UpdateShortcutInput): Promise<Shortcut>;
  list(query?: string): Promise<readonly Shortcut[]>;
  find(slug: string): Promise<Shortcut | null>;
  /** Like `find`, but throws `NotFoundError` instead of returning null. */
  require(slug: string): Promise<Shortcut>;
  remove(slug: string): Promise<void>;
  /** Increments the hit counter. Never throws for an unknown slug. */
  recordHit(slug: string): Promise<void>;
}

/** Called after every mutation so a storage backend can durably record the set. */
type Persist = (shortcuts: readonly Shortcut[]) => Promise<void>;

const noPersist: Persist = async () => {};

/**
 * Holds the full shortcut set in memory and delegates durability to `persist`.
 *
 * The set is small by nature (an internal link directory, not user content), so
 * keeping it in memory buys simple, synchronous search and ordering. Swapping in
 * a database later means implementing `ShortcutRepository` — nothing above this
 * layer knows how shortcuts are stored.
 */
export class InMemoryShortcutRepository implements ShortcutRepository {
  readonly #shortcuts = new Map<string, Shortcut>();
  readonly #persist: Persist;

  constructor(seed: readonly Shortcut[] = [], persist: Persist = noPersist) {
    for (const shortcut of seed) this.#shortcuts.set(shortcut.slug, shortcut);
    this.#persist = persist;
  }

  async create(input: CreateShortcutInput, actor: string | null = null): Promise<Shortcut> {
    const slug = normaliseSlug(input.slug);
    if (this.#shortcuts.has(slug)) {
      throw new ConflictError(`The shortcut "go/${slug}" already exists.`, [
        { field: 'slug', message: 'That shortcut name is already taken.' },
      ]);
    }

    const now = new Date().toISOString();
    const shortcut: Shortcut = {
      slug,
      url: input.url,
      description: input.description,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      lastAccessedAt: null,
    };

    this.#shortcuts.set(slug, shortcut);
    await this.#save();
    return shortcut;
  }

  async update(slug: string, patch: UpdateShortcutInput): Promise<Shortcut> {
    const existing = await this.require(slug);
    const updated: Shortcut = {
      ...existing,
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.#shortcuts.set(existing.slug, updated);
    await this.#save();
    return updated;
  }

  async list(query?: string): Promise<readonly Shortcut[]> {
    const all = [...this.#shortcuts.values()];
    const term = query?.trim().toLowerCase();
    const matched = term ? all.filter((shortcut) => matches(shortcut, term)) : all;
    // Most-used first, then newest: the list doubles as the discovery surface, so
    // the shortcuts people actually rely on should be the ones they see first.
    return matched.sort((a, b) => b.hits - a.hits || b.createdAt.localeCompare(a.createdAt));
  }

  async find(slug: string): Promise<Shortcut | null> {
    return this.#shortcuts.get(normaliseSlug(slug)) ?? null;
  }

  async require(slug: string): Promise<Shortcut> {
    const shortcut = await this.find(slug);
    if (!shortcut) throw new NotFoundError(`No shortcut named "go/${normaliseSlug(slug)}".`);
    return shortcut;
  }

  async remove(slug: string): Promise<void> {
    const key = normaliseSlug(slug);
    if (!this.#shortcuts.delete(key)) {
      throw new NotFoundError(`No shortcut named "go/${key}".`);
    }
    await this.#save();
  }

  async recordHit(slug: string): Promise<void> {
    const key = normaliseSlug(slug);
    const shortcut = this.#shortcuts.get(key);
    if (!shortcut) return;
    this.#shortcuts.set(key, {
      ...shortcut,
      hits: shortcut.hits + 1,
      lastAccessedAt: new Date().toISOString(),
    });
    await this.#save();
  }

  async #save(): Promise<void> {
    await this.#persist([...this.#shortcuts.values()]);
  }
}

const matches = (shortcut: Shortcut, term: string): boolean =>
  shortcut.slug.includes(term) ||
  shortcut.url.toLowerCase().includes(term) ||
  (shortcut.description?.toLowerCase().includes(term) ?? false);

/**
 * Builds a repository backed by a JSON file.
 *
 * Writes go to a temporary file and are then renamed over the target, which is
 * atomic on POSIX filesystems — a crash mid-write leaves the previous file
 * intact rather than a truncated one. This assumes a single server process owns
 * the file; see the README for why that tradeoff is acceptable here.
 */
export const createJsonFileRepository = async (
  filePath: string,
): Promise<ShortcutRepository> => {
  const seed = await readStore(filePath);
  return new InMemoryShortcutRepository(seed, async (shortcuts) => {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(shortcuts, null, 2), 'utf8');
    await rename(temporaryPath, filePath);
  });
};

const readStore = async (filePath: string): Promise<readonly Shortcut[]> => {
  try {
    const contents = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(contents);
    if (!Array.isArray(parsed)) return [];
    // Fields added after the first release default on read, so an older store
    // file keeps working without a migration step.
    return (parsed as Partial<Shortcut>[]).map((row) => ({
      ...(row as Shortcut),
      createdBy: row.createdBy ?? null,
      updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0).toISOString(),
      lastAccessedAt: row.lastAccessedAt ?? null,
    }));
  } catch (error) {
    // A missing file is the expected first-run state, not a failure. Anything
    // else (corrupt JSON, bad permissions) should stop startup loudly rather
    // than silently serving an empty directory over real data.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};
