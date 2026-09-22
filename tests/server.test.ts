import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { InMemoryShortcutRepository } from '../src/core/repository.js';
import { buildApp } from '../src/server/app.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ repository: new InMemoryShortcutRepository(), logger: false });
});

afterEach(async () => {
  await app.close();
});

const createViaApi = (slug: string, url = 'https://pager.internal/rota') =>
  app.inject({ method: 'POST', url: '/api/shortcuts', payload: { slug, url } });

describe('JSON API', () => {
  test('creates a shortcut and points at where it now lives', async () => {
    const response = await createViaApi('oncall');

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe('/oncall');
    expect(response.json().data).toMatchObject({ slug: 'oncall', hits: 0 });
  });

  test('returns a problem document with field-level errors', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      payload: { slug: 'api', url: 'nope' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json();
    expect(problem.title).toBe('validation_failed');
    expect(problem.errors.map((issue: { field: string }) => issue.field)).toEqual(['slug', 'url']);
    expect(problem.requestId).toBeTruthy();
  });

  test('reports a duplicate slug as a conflict rather than overwriting', async () => {
    await createViaApi('oncall');
    const response = await createViaApi('oncall', 'https://somewhere.else.internal');

    expect(response.statusCode).toBe(409);
    expect(response.json().title).toBe('slug_taken');
  });

  test('lists and searches shortcuts', async () => {
    await createViaApi('oncall');
    await createViaApi('payroll', 'https://finance.internal/pay');

    expect((await app.inject('/api/shortcuts')).json().meta.count).toBe(2);
    expect((await app.inject('/api/shortcuts?q=finance')).json().data).toHaveLength(1);
  });

  test('deletes a shortcut and then reports it missing', async () => {
    await createViaApi('oncall');

    expect((await app.inject({ method: 'DELETE', url: '/api/shortcuts/oncall' })).statusCode).toBe(204);
    expect((await app.inject('/api/shortcuts/oncall')).statusCode).toBe(404);
  });

  test('updates a shortcut in place and records who did it', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      headers: { 'x-forwarded-user': 'alice' },
      payload: { slug: 'oncall', url: 'https://pager.internal/rota' },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/shortcuts/oncall',
      headers: { 'x-forwarded-user': 'alice' },
      payload: { url: 'https://pager.internal/v2' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ url: 'https://pager.internal/v2', createdBy: 'alice' });
  });

  test('stops a known stranger from editing or deleting someone else\'s shortcut', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      headers: { 'x-forwarded-user': 'alice' },
      payload: { slug: 'oncall', url: 'https://pager.internal/rota' },
    });

    const edit = await app.inject({
      method: 'PUT',
      url: '/api/shortcuts/oncall',
      headers: { 'x-forwarded-user': 'mallory' },
      payload: { url: 'https://evil.example' },
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json().title).toBe('not_owner');

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/shortcuts/oncall',
      headers: { 'x-golinks-user': 'mallory' },
    });
    expect(del.statusCode).toBe(403);

    // Anonymous callers are not blocked — ownership is a guard, not a lock.
    expect((await app.inject({ method: 'DELETE', url: '/api/shortcuts/oncall' })).statusCode).toBe(204);
  });

  test('refuses a destination that loops back to the host it was created on', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      headers: { host: 'go.corp.example' },
      payload: { slug: 'loop', url: 'https://go.corp.example/loop' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].message).toContain('point back');
  });

  test('refuses a destination on a metadata or private address', async () => {
    const response = await createViaApi('meta', 'http://169.254.169.254/latest/meta-data/');
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].field).toBe('url');
  });

  test('echoes the caller request ID so logs can be correlated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'trace-123' },
    });

    expect(response.headers['x-request-id']).toBe('trace-123');
    expect(response.json().status).toBe('ok');
  });
});

describe('redirects', () => {
  test('sends a visitor to the destination and counts the hit', async () => {
    await createViaApi('oncall');

    const response = await app.inject('/oncall');

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://pager.internal/rota');
    expect(response.headers['cache-control']).toBe('no-store');

    const shortcut = (await app.inject('/api/shortcuts/oncall')).json().data;
    expect(shortcut.hits).toBe(1);
  });

  test('forwards a path suffix and query string onto the destination', async () => {
    await createViaApi('jira', 'https://jira.internal/browse');

    const response = await app.inject('/jira/ABC-123?focus=1');

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://jira.internal/browse/ABC-123?focus=1');
  });

  test('resolves a slug case-insensitively', async () => {
    await createViaApi('oncall');
    expect((await app.inject('/OnCall')).statusCode).toBe(302);
  });

  test('offers to create an unknown shortcut instead of dead-ending', async () => {
    const response = await app.inject({ url: '/nothing-here', headers: { accept: 'text/html' } });

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Create');
    expect(response.body).toContain('/?slug=nothing-here');
  });
});

describe('HTML interface', () => {
  test('renders the directory without requiring JavaScript', async () => {
    await createViaApi('oncall');

    const response = await app.inject({ url: '/', headers: { accept: 'text/html' } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<form method="post" action="/api/shortcuts"');
    expect(response.body).toContain('/oncall');
    expect(response.body).not.toContain('<script');
  });

  test('redirects after a successful form post so refresh cannot resubmit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'slug=oncall&url=https%3A%2F%2Fpager.internal%2Frota',
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/?created=oncall');
  });

  test('returns the form with the input preserved when validation fails', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'slug=oncall&url=not-a-url',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('value="oncall"');
    expect(response.body).toContain('aria-invalid="true"');
    expect(response.body).toContain('role="alert"');
  });

  test('offers edit and delete from the list, and an edit form that saves via POST', async () => {
    await createViaApi('oncall');

    const list = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect(list.body).toContain('href="/?edit=oncall"');
    expect(list.body).toContain('action="/api/shortcuts/oncall/delete"');

    const editForm = await app.inject({ url: '/?edit=oncall', headers: { accept: 'text/html' } });
    expect(editForm.body).toContain('action="/api/shortcuts/oncall"');
    expect(editForm.body).toContain('value="https://pager.internal/rota"');
    expect(editForm.body).not.toContain('name="slug"');

    const save = await app.inject({
      method: 'POST',
      url: '/api/shortcuts/oncall',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'url=https%3A%2F%2Fpager.internal%2Fv2&description=',
    });
    expect(save.statusCode).toBe(303);
    expect(save.headers.location).toBe('/?updated=oncall');
    expect((await app.inject('/api/shortcuts/oncall')).json().data.url).toBe('https://pager.internal/v2');

    const remove = await app.inject({
      method: 'POST',
      url: '/api/shortcuts/oncall/delete',
      headers: { accept: 'text/html' },
    });
    expect(remove.statusCode).toBe(303);
    expect(remove.headers.location).toBe('/?deleted=oncall');
  });

  test('escapes user input rather than rendering it as markup', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/shortcuts',
      payload: { slug: 'xss', url: 'https://example.internal/', description: '<img src=x onerror=1>' },
    });

    const response = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect(response.body).not.toContain('<img src=x');
    expect(response.body).toContain('&lt;img src=x');
  });
});

describe('metrics', () => {
  test('exposes redirect outcomes and shortcut count in Prometheus format', async () => {
    await createViaApi('oncall');
    await app.inject('/oncall');
    await app.inject('/missing');

    const response = await app.inject('/metrics');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('golinks_redirects_total{outcome="hit"} 1');
    expect(response.body).toContain('golinks_redirects_total{outcome="miss"} 1');
    expect(response.body).toContain('golinks_shortcuts 1');
    expect(response.body).toContain('golinks_http_request_duration_seconds_bucket');
  });
});
