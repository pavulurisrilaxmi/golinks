import type { FastifyReply, FastifyRequest } from 'fastify';
import { isAppError, type FieldIssue } from '../core/errors.js';
import { renderProblem } from './views.js';

/** An RFC 7807 `application/problem+json` document. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly requestId: string;
  readonly errors?: ReadonlyArray<FieldIssue>;
}

const PROBLEM_BASE = 'https://golinks.internal/problems';

export const toProblem = (error: unknown, requestId: string): Problem => {
  if (isAppError(error)) {
    return {
      type: `${PROBLEM_BASE}/${error.code}`,
      title: error.code,
      status: error.status,
      detail: error.message,
      requestId,
      ...(error.details ? { errors: error.details } : {}),
    };
  }

  // Unexpected failures are logged in full but described vaguely to the client:
  // the request ID is the thread that ties the two together during an incident.
  return {
    type: `${PROBLEM_BASE}/internal_error`,
    title: 'internal_error',
    status: 500,
    detail: 'Something went wrong. Quote the request ID when reporting this.',
    requestId,
  };
};

/**
 * Single exit point for every error in the service. Browsers get HTML, API
 * clients get problem+json, and both get the same request ID.
 */
export const errorHandler = async (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const problem = toProblem(error, request.id);

  if (problem.status >= 500) {
    request.log.error({ err: error }, 'request failed');
  } else {
    request.log.warn({ code: problem.title, detail: problem.detail }, 'request rejected');
  }

  if (!wantsHtml(request)) {
    await reply.status(problem.status).type('application/problem+json').send(problem);
    return;
  }

  await reply.status(problem.status).type('text/html; charset=utf-8').send(renderProblem(problem));
};

export const wantsHtml = (request: FastifyRequest): boolean =>
  (request.headers.accept ?? '').includes('text/html');
