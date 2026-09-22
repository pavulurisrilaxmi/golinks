import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DestinationPolicy } from '../core/destination.js';
import type { ShortcutRepository } from '../core/repository.js';
import {
  assertCanModify,
  normaliseSlug,
  parseCreateShortcut,
  parseUpdateShortcut,
  resolveDestination,
} from '../core/shortcut.js';
import { actorFrom } from './identity.js';
import type { Metrics } from './metrics.js';
import { toProblem, wantsHtml } from './problem.js';
import { renderIndex, renderUnknownSlug, type SubmittedForm } from './views.js';

interface SlugParams {
  readonly slug: string;
  readonly '*'?: string;
}

interface IndexQuery {
  readonly q?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly deleted?: string;
  readonly slug?: string;
  readonly edit?: string;
}

export const registerRoutes = (
  app: FastifyInstance,
  repository: ShortcutRepository,
  metrics: Metrics,
  basePolicy: DestinationPolicy,
): void => {
  // The Host header the request arrived on is always a "self" host: whatever
  // name people use to reach this service, a shortcut must not loop back to it.
  const policyFor = (request: FastifyRequest): DestinationPolicy => {
    const host = request.headers.host?.toLowerCase();
    if (!host) return basePolicy;
    const selfHosts = new Set(basePolicy.selfHosts);
    selfHosts.add(host);
    selfHosts.add(host.replace(/:\d+$/, ''));
    return { ...basePolicy, selfHosts };
  };

  app.get('/healthz', async () => {
    const shortcuts = await repository.list();
    return { status: 'ok', shortcuts: shortcuts.length, uptimeSeconds: Math.round(process.uptime()) };
  });

  app.get<{ Querystring: IndexQuery }>('/', async (request, reply) => {
    const query = request.query.q ?? '';
    const shortcuts = await repository.list(query);
    const editing = request.query.edit ? await repository.find(request.query.edit) : null;
    return html(
      reply,
      200,
      renderIndex({
        shortcuts,
        query,
        notice: noticeFrom(request.query),
        ...(editing ? { editing } : {}),
        // Arriving from a 404 page pre-fills the name the user already tried.
        ...(request.query.slug
          ? { submitted: { slug: request.query.slug, url: '', description: '' } }
          : {}),
      }),
    );
  });

  app.post('/api/shortcuts', async (request, reply) => {
    const browser = wantsHtml(request);
    try {
      const input = parseCreateShortcut(request.body, policyFor(request));
      const actor = actorFrom(request);
      const shortcut = await repository.create(input, actor);
      request.log.info({ slug: shortcut.slug, actor }, 'shortcut created');

      if (browser) {
        // POST/Redirect/GET: a refresh after creating must not re-submit the form.
        return reply.redirect(`/?created=${encodeURIComponent(shortcut.slug)}`, 303);
      }
      return reply.status(201).header('location', `/${shortcut.slug}`).send({ data: shortcut });
    } catch (error) {
      return browser ? formFailure(error, request, reply, repository, null) : Promise.reject(error);
    }
  });

  app.get<{ Querystring: { q?: string } }>('/api/shortcuts', async (request) => {
    const shortcuts = await repository.list(request.query.q);
    return { data: shortcuts, meta: { count: shortcuts.length } };
  });

  app.get<{ Params: SlugParams }>('/api/shortcuts/:slug', async (request) => {
    return { data: await repository.require(request.params.slug) };
  });

  // PUT for API clients; POST for the HTML edit form, which can only POST.
  const update = async (request: FastifyRequest<{ Params: SlugParams }>, reply: FastifyReply) => {
    const browser = wantsHtml(request);
    try {
      const existing = await repository.require(request.params.slug);
      const actor = actorFrom(request);
      assertCanModify(existing, actor);
      const patch = parseUpdateShortcut(request.body, policyFor(request));
      const shortcut = await repository.update(existing.slug, patch);
      request.log.info({ slug: shortcut.slug, actor }, 'shortcut updated');

      if (browser) {
        return reply.redirect(`/?updated=${encodeURIComponent(shortcut.slug)}`, 303);
      }
      return { data: shortcut };
    } catch (error) {
      if (!browser) throw error;
      const editing = await repository.find(request.params.slug);
      return formFailure(error, request, reply, repository, editing);
    }
  };
  app.put<{ Params: SlugParams }>('/api/shortcuts/:slug', update);
  app.post<{ Params: SlugParams }>('/api/shortcuts/:slug', update);

  const remove = async (request: FastifyRequest<{ Params: SlugParams }>, reply: FastifyReply) => {
    const existing = await repository.require(request.params.slug);
    const actor = actorFrom(request);
    assertCanModify(existing, actor);
    await repository.remove(existing.slug);
    request.log.info({ slug: existing.slug, actor }, 'shortcut deleted');

    if (wantsHtml(request)) {
      return reply.redirect(`/?deleted=${encodeURIComponent(existing.slug)}`, 303);
    }
    return reply.status(204).send();
  };
  app.delete<{ Params: SlugParams }>('/api/shortcuts/:slug', remove);
  app.post<{ Params: SlugParams }>('/api/shortcuts/:slug/delete', remove);

  // `/oncall` and `/jira/ABC-123` both land here. The wildcard captures a path
  // suffix that is appended to the destination, so one shortcut can front a
  // whole tree of URLs (`go/jira/<ticket>`).
  const redirect = async (request: FastifyRequest<{ Params: SlugParams }>, reply: FastifyReply) => {
    const slug = normaliseSlug(request.params.slug);
    const shortcut = await repository.find(slug);

    if (!shortcut) {
      metrics.redirects.inc({ outcome: 'miss' });
      request.log.info({ slug }, 'shortcut miss');
      if (!wantsHtml(request)) {
        return reply.callNotFound();
      }
      return html(reply, 404, renderUnknownSlug(slug));
    }

    // Counting the hit must never delay or fail the redirect — it is analytics,
    // not part of the contract. Failures are logged and dropped.
    void repository
      .recordHit(shortcut.slug)
      .catch((error: unknown) => request.log.warn({ err: error }, 'hit counter failed'));

    metrics.redirects.inc({ outcome: 'hit' });
    const destination = resolveDestination(shortcut.url, request.params['*'], queryStringOf(request.url));
    request.log.info({ slug: shortcut.slug, suffix: request.params['*'] ?? null }, 'shortcut hit');
    // 302, never 301: shortcuts are editable, and a permanent redirect would be
    // cached by browsers long after the destination changed.
    return reply.header('cache-control', 'no-store').redirect(destination, 302);
  };

  app.get<{ Params: SlugParams }>('/:slug', redirect);
  app.get<{ Params: SlugParams }>('/:slug/*', redirect);
};

/**
 * Browsers get the form back with their input and the messages attached to the
 * offending fields. Anything that is not a client error is re-thrown so the
 * global handler logs it and renders a generic 500.
 */
const formFailure = async (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  repository: ShortcutRepository,
  editing: Awaited<ReturnType<ShortcutRepository['find']>>,
): Promise<FastifyReply> => {
  const problem = toProblem(error, request.id);
  if (problem.status >= 500) throw error;

  request.log.warn({ code: problem.title }, 'form rejected');
  const shortcuts = await repository.list();
  return html(
    reply,
    problem.status,
    renderIndex({
      shortcuts,
      query: '',
      problem,
      submitted: submittedFrom(request.body, editing?.slug),
      ...(editing ? { editing } : {}),
    }),
  );
};

const noticeFrom = (query: IndexQuery): { verb: string; slug: string } | undefined => {
  if (query.created) return { verb: 'Created', slug: query.created };
  if (query.updated) return { verb: 'Updated', slug: query.updated };
  if (query.deleted) return { verb: 'Deleted', slug: query.deleted };
  return undefined;
};

const html = (reply: FastifyReply, status: number, body: string): FastifyReply =>
  reply.status(status).type('text/html; charset=utf-8').send(body);

const queryStringOf = (url: string): string => {
  const index = url.indexOf('?');
  return index === -1 ? '' : url.slice(index + 1);
};

const submittedFrom = (body: unknown, slug?: string): SubmittedForm => {
  const source = (body ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    slug: slug ?? text(source.slug),
    url: text(source.url),
    description: text(source.description),
  };
};
