import { randomUUID } from 'node:crypto';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { defaultDestinationPolicy, type DestinationPolicy } from '../core/destination.js';
import type { ShortcutRepository } from '../core/repository.js';
import { createMetrics } from './metrics.js';
import { errorHandler, wantsHtml } from './problem.js';
import { registerRoutes } from './routes.js';
import { renderProblem } from './views.js';

export interface BuildAppOptions {
  readonly repository: ShortcutRepository;
  readonly logger?: boolean | object;
  readonly policy?: DestinationPolicy;
}

export const buildApp = async ({
  repository,
  logger = true,
  policy = defaultDestinationPolicy(),
}: BuildAppOptions): Promise<FastifyInstance> => {
  const app = Fastify({
    logger,
    // Trust an inbound request ID so a shortcut hit can be correlated with the
    // upstream proxy or client that triggered it; mint one otherwise.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  // The create form posts application/x-www-form-urlencoded; the JSON parser is
  // built in. Both boundaries feed the same validation.
  await app.register(formbody);

  const metrics = createMetrics();

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    // `routeOptions.url` is the pattern (`/:slug`), not the concrete path, so
    // label cardinality stays equal to the number of routes.
    metrics.requestDuration
      .labels(request.method, request.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (_request, reply) => {
    metrics.shortcuts.set((await repository.list()).length);
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler(async (request, reply) => {
    const problem = {
      type: 'https://golinks.internal/problems/route_not_found',
      title: 'route_not_found',
      status: 404,
      detail: `No route for ${request.method} ${request.url}.`,
      requestId: request.id,
    };
    if (wantsHtml(request)) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderProblem(problem));
    }
    return reply.status(404).type('application/problem+json').send(problem);
  });

  registerRoutes(app, repository, metrics, policy);
  return app;
};
