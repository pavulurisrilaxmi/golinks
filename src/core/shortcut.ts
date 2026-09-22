import { z } from 'zod';
import { assertDestinationAllowed, type DestinationPolicy } from './destination.js';
import { ForbiddenError, ValidationError, type FieldIssue } from './errors.js';

/**
 * A shortcut maps a short, memorable slug to a destination URL:
 * `go/oncall` -> `https://pager.internal/rota`.
 */
export interface Shortcut {
  readonly slug: string;
  readonly url: string;
  readonly description: string | null;
  /** Who created it, as reported by the proxy or CLI. Null when unknown. */
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hits: number;
  readonly lastAccessedAt: string | null;
}

/**
 * Slugs live in the same namespace as the server's own routes, so anything the
 * server needs for itself is reserved. Keeping the list here (rather than in the
 * routing layer) means the rule is enforced identically however a shortcut is
 * created — HTML form, JSON API, or a future importer.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'healthz',
  'health',
  'metrics',
  'favicon.ico',
  'robots.txt',
  'new',
  'static',
  'assets',
]);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 200;

const slugSchema = z
  .string({ required_error: 'Enter a shortcut name.' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter a shortcut name.')
  .max(32, 'Use 32 characters or fewer.')
  .regex(
    SLUG_PATTERN,
    'Use lowercase letters, numbers and hyphens only, starting with a letter or number.',
  )
  .refine((slug) => !RESERVED_SLUGS.has(slug), 'That name is reserved by the service.');

const urlSchema = z
  .string({ required_error: 'Enter a destination URL.' })
  .trim()
  .min(1, 'Enter a destination URL.')
  .max(MAX_URL_LENGTH, `Use ${MAX_URL_LENGTH} characters or fewer.`)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a full URL, including https://',
      });
      return;
    }
    // Anything other than http(s) — `javascript:`, `data:`, `file:` — would turn a
    // shortcut into a redirect-based attack vector, so the scheme is allow-listed.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only http:// and https:// destinations are allowed.',
      });
    }
  });

const descriptionSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_LENGTH, `Use ${MAX_DESCRIPTION_LENGTH} characters or fewer.`)
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value));

export const createShortcutSchema = z.object({
  slug: slugSchema,
  url: urlSchema,
  description: descriptionSchema,
});

export type CreateShortcutInput = z.infer<typeof createShortcutSchema>;

/** Either field may be changed; the slug is the identity and cannot. */
// On update, an absent description means "leave it", an empty one means "clear it".
const updateDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_LENGTH, `Use ${MAX_DESCRIPTION_LENGTH} characters or fewer.`)
  .optional()
  .transform((value) => (value === undefined ? undefined : value === '' ? null : value));

export const updateShortcutSchema = z
  .object({
    url: urlSchema.optional(),
    description: updateDescriptionSchema,
  })
  .refine((patch) => patch.url !== undefined || patch.description !== undefined, {
    message: 'Provide a new URL or description.',
    path: ['body'],
  });

export type UpdateShortcutInput = z.infer<typeof updateShortcutSchema>;

/**
 * Validates untrusted input from any boundary (JSON body, HTML form or CLI) and
 * returns a normalised, trusted value. Throws `ValidationError` with per-field
 * messages so every surface can render the same guidance.
 */
export const parseCreateShortcut = (
  input: unknown,
  policy?: DestinationPolicy,
): CreateShortcutInput => {
  const data = parseWith(createShortcutSchema, input);
  if (policy) assertDestinationAllowed(data.url, policy);
  return data;
};

export const parseUpdateShortcut = (
  input: unknown,
  policy?: DestinationPolicy,
): UpdateShortcutInput => {
  const data = parseWith(updateShortcutSchema, input);
  if (policy && data.url !== undefined) assertDestinationAllowed(data.url, policy);
  return data;
};

/**
 * Ownership is an accident guard, not access control: identities arrive as
 * headers and are only as trustworthy as the proxy that set them. The rule is
 * deliberately lenient — a shortcut with no recorded owner, or a caller with no
 * identity, is never blocked. Only a *known* stranger is.
 */
export const assertCanModify = (shortcut: Shortcut, actor: string | null): void => {
  if (shortcut.createdBy === null || actor === null) return;
  if (shortcut.createdBy.toLowerCase() === actor.toLowerCase()) return;
  throw new ForbiddenError(
    `"go/${shortcut.slug}" belongs to ${shortcut.createdBy}. Ask them, or identify as them, to change it.`,
  );
};

const parseWith = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details: FieldIssue[] = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || 'body',
    message: issue.message,
  }));
  throw new ValidationError('The shortcut could not be saved.', details);
};

/**
 * Builds the final redirect target. A path suffix on the request is appended to
 * the destination path, and the request's query string is merged in, so
 * `/jira/ABC-123?focus=1` against `https://jira.internal/browse` becomes
 * `https://jira.internal/browse/ABC-123?focus=1`.
 */
export const resolveDestination = (
  url: string,
  suffix: string | undefined,
  queryString: string,
): string => {
  const target = new URL(url);

  if (suffix) {
    const base = target.pathname.endsWith('/') ? target.pathname : `${target.pathname}/`;
    // Re-encode each segment so a suffix cannot smuggle in `..` or inject a
    // second query string; the wildcard arrives decoded.
    const encoded = suffix
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
      .map(encodeURIComponent)
      .join('/');
    target.pathname = base + encoded;
  }

  if (queryString) {
    for (const [key, value] of new URLSearchParams(queryString)) {
      target.searchParams.append(key, value);
    }
  }

  return target.toString();
};

/** Normalises a slug for lookups so `/Oncall` and `/oncall` resolve to one shortcut. */
export const normaliseSlug = (slug: string): string => slug.trim().toLowerCase();
