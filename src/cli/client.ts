import type { Shortcut } from '../core/shortcut.js';

/**
 * Thin client over the JSON API. Deliberately a few `fetch` calls rather than a
 * generated SDK: the API has four operations and the CLI is its only consumer.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly issues: ReadonlyArray<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface CreateRequest {
  readonly slug: string;
  readonly url: string;
  readonly description?: string;
}

export interface UpdateRequest {
  readonly url?: string;
  readonly description?: string;
}

export class GoLinksClient {
  constructor(
    private readonly baseUrl: string,
    /** Sent as `x-golinks-user` so the server can record who did what. */
    private readonly identity: string | null = null,
  ) {}

  async create(input: CreateRequest): Promise<Shortcut> {
    const body = await this.#call('POST', '/api/shortcuts', input);
    return (body as { data: Shortcut }).data;
  }

  async update(slug: string, patch: UpdateRequest): Promise<Shortcut> {
    const body = await this.#call('PUT', `/api/shortcuts/${encodeURIComponent(slug)}`, patch);
    return (body as { data: Shortcut }).data;
  }

  async list(query?: string): Promise<readonly Shortcut[]> {
    const path = query ? `/api/shortcuts?q=${encodeURIComponent(query)}` : '/api/shortcuts';
    const body = await this.#call('GET', path);
    return (body as { data: Shortcut[] }).data;
  }

  async get(slug: string): Promise<Shortcut> {
    const body = await this.#call('GET', `/api/shortcuts/${encodeURIComponent(slug)}`);
    return (body as { data: Shortcut }).data;
  }

  async remove(slug: string): Promise<void> {
    await this.#call('DELETE', `/api/shortcuts/${encodeURIComponent(slug)}`);
  }

  async #call(method: string, path: string, payload?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        accept: 'application/json',
        ...(this.identity ? { 'x-golinks-user': this.identity } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });

    if (response.ok) {
      return response.status === 204 ? undefined : response.json();
    }

    // The server speaks RFC 7807; surface its fields rather than a bare status.
    const problem = (await response.json().catch(() => ({}))) as Partial<{
      title: string;
      detail: string;
      requestId: string;
      errors: { field: string; message: string }[];
    }>;
    throw new ApiError(
      response.status,
      problem.title ?? 'http_error',
      problem.detail ?? `${method} ${path} failed with ${response.status}`,
      problem.requestId ?? null,
      problem.errors ?? [],
    );
  }
}
