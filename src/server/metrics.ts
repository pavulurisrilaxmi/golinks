import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics for the service. Hit counts in the store answer "which
 * shortcuts are popular"; these answer "is the service healthy right now" —
 * miss rate, redirect latency, request volume — which a store cannot.
 *
 * Slug is deliberately not a label on the redirect counter: labels are
 * unbounded cardinality if users can mint them, and the store already holds
 * per-slug counts.
 */
export interface Metrics {
  readonly registry: Registry;
  readonly redirects: Counter<'outcome'>;
  readonly shortcuts: Gauge;
  readonly requestDuration: Histogram<'method' | 'route' | 'status'>;
}

export const createMetrics = (): Metrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'golinks_' });

  return {
    registry,
    redirects: new Counter({
      name: 'golinks_redirects_total',
      help: 'Shortcut lookups, by whether a destination was found.',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    shortcuts: new Gauge({
      name: 'golinks_shortcuts',
      help: 'Number of shortcuts currently defined.',
      registers: [registry],
    }),
    requestDuration: new Histogram({
      name: 'golinks_http_request_duration_seconds',
      help: 'HTTP request latency by route.',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
  };
};
