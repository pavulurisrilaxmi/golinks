import { describe, expect, test } from 'vitest';
import { ForbiddenError, ValidationError } from '../src/core/errors.js';
import {
  assertCanModify,
  parseCreateShortcut,
  parseUpdateShortcut,
  resolveDestination,
  type Shortcut,
} from '../src/core/shortcut.js';

const valid = { slug: 'oncall', url: 'https://pager.internal/rota' };

describe('parseCreateShortcut', () => {
  test('accepts a well-formed shortcut and normalises it', () => {
    const result = parseCreateShortcut({ slug: '  OnCall ', url: 'https://pager.internal/rota' });

    expect(result.slug).toBe('oncall');
    expect(result.url).toBe('https://pager.internal/rota');
    expect(result.description).toBeNull();
  });

  test('treats a blank description as absent', () => {
    expect(parseCreateShortcut({ ...valid, description: '   ' }).description).toBeNull();
  });

  test('rejects a slug containing unsupported characters', () => {
    expect(() => parseCreateShortcut({ ...valid, slug: 'on call!' })).toThrow(ValidationError);
  });

  test('rejects a slug reserved by the service', () => {
    for (const slug of ['api', 'healthz', 'metrics']) {
      expect(() => parseCreateShortcut({ ...valid, slug })).toThrow(ValidationError);
    }
  });

  test('rejects a non-http scheme so shortcuts cannot become script vectors', () => {
    expect(() => parseCreateShortcut({ ...valid, url: 'javascript:alert(1)' })).toThrow(
      ValidationError,
    );
  });

  test('rejects a URL that is not absolute', () => {
    expect(() => parseCreateShortcut({ ...valid, url: 'pager.internal/rota' })).toThrow(
      ValidationError,
    );
  });

  test('reports which field failed so the form can mark it', () => {
    try {
      parseCreateShortcut({ slug: 'ok', url: 'nope' });
      expect.unreachable('expected a ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details?.[0]?.field).toBe('url');
    }
  });
});

describe('resolveDestination', () => {
  const base = 'https://jira.internal/browse';

  test('returns the destination untouched when there is no suffix or query', () => {
    expect(resolveDestination(base, undefined, '')).toBe('https://jira.internal/browse');
  });

  test('appends a path suffix without doubling slashes', () => {
    expect(resolveDestination(base, 'ABC-123', '')).toBe('https://jira.internal/browse/ABC-123');
    expect(resolveDestination(`${base}/`, 'ABC-123', '')).toBe('https://jira.internal/browse/ABC-123');
  });

  test('merges the request query string into the destination', () => {
    expect(resolveDestination(`${base}?view=all`, 'ABC-123', 'focus=1')).toBe(
      'https://jira.internal/browse/ABC-123?view=all&focus=1',
    );
  });

  test('drops dot segments so a suffix cannot climb out of the destination path', () => {
    expect(resolveDestination(base, '../../admin', '')).toBe('https://jira.internal/browse/admin');
  });

  test('encodes suffix segments so they cannot inject a second query string', () => {
    expect(resolveDestination(base, 'a?b=c', '')).toBe('https://jira.internal/browse/a%3Fb%3Dc');
  });
});

describe('parseUpdateShortcut', () => {
  test('accepts a url-only change and leaves description untouched', () => {
    expect(parseUpdateShortcut({ url: 'https://new.internal' })).toEqual({
      url: 'https://new.internal',
      description: undefined,
    });
  });

  test('treats an empty description as a request to clear it', () => {
    expect(parseUpdateShortcut({ description: '' })).toEqual({ url: undefined, description: null });
  });

  test('rejects an empty patch', () => {
    expect(() => parseUpdateShortcut({})).toThrow(ValidationError);
  });
});

describe('assertCanModify', () => {
  const owned: Shortcut = {
    slug: 'x',
    url: 'https://x.internal',
    description: null,
    createdBy: 'Alice@Example.com',
    createdAt: 't',
    updatedAt: 't',
    hits: 0,
    lastAccessedAt: null,
  };

  test('allows the owner, case-insensitively', () => {
    expect(() => assertCanModify(owned, 'alice@example.com')).not.toThrow();
  });

  test('allows anyone when either side is anonymous', () => {
    expect(() => assertCanModify(owned, null)).not.toThrow();
    expect(() => assertCanModify({ ...owned, createdBy: null }, 'mallory')).not.toThrow();
  });

  test('blocks a known stranger', () => {
    expect(() => assertCanModify(owned, 'mallory')).toThrow(ForbiddenError);
  });
});
