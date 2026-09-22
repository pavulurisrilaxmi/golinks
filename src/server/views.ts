import type { FieldIssue } from '../core/errors.js';
import type { Shortcut } from '../core/shortcut.js';
import type { Problem } from './problem.js';

/**
 * Server-rendered HTML. There is no client-side JavaScript anywhere in this
 * service: the whole product is a form, a table and a redirect, and keeping it
 * script-free means it works in any browser, degrades gracefully, and has no
 * build step to maintain.
 */

const escape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export interface SubmittedForm {
  readonly slug: string;
  readonly url: string;
  readonly description: string;
}

export interface IndexView {
  readonly shortcuts: readonly Shortcut[];
  readonly query: string;
  readonly notice?: { verb: string; slug: string } | undefined;
  readonly problem?: Problem;
  readonly submitted?: SubmittedForm;
  /** When set, the form edits this shortcut instead of creating a new one. */
  readonly editing?: Shortcut;
}

export const renderIndex = (view: IndexView): string => {
  const issues = view.problem?.errors ?? [];
  const editing = view.editing;
  const submitted: SubmittedForm = view.submitted ??
    (editing
      ? { slug: editing.slug, url: editing.url, description: editing.description ?? '' }
      : { slug: '', url: '', description: '' });

  return layout(
    editing ? `Edit /${editing.slug}` : 'Shortcuts',
    `
    <h1>Go Links</h1>
    <p class="lede">Short, memorable URLs for internal tools. Visit <code>/oncall</code> to be sent to whatever <code>oncall</code> points at today.</p>

    ${view.notice ? banner(`${escape(view.notice.verb)} <code>/${escape(view.notice.slug)}</code>.`) : ''}
    ${issues.length > 0 ? errorSummary(view.problem?.detail ?? 'Check the form.', issues) : ''}

    <section aria-labelledby="form-heading" class="panel">
      <h2 id="form-heading">${editing ? `Edit <code>/${escape(editing.slug)}</code>` : 'Create a shortcut'}</h2>
      <form method="post" action="${editing ? `/api/shortcuts/${escape(editing.slug)}` : '/api/shortcuts'}" class="create-form">
        ${editing ? '' : `
        <div class="field">
          <label for="slug">Shortcut name</label>
          <span class="hint" id="slug-hint">Lowercase letters, numbers and hyphens. Becomes <code>/name</code>.</span>
          <input id="slug" name="slug" required maxlength="32" autocomplete="off" spellcheck="false"
                 aria-describedby="slug-hint${fieldError(issues, 'slug') ? ' slug-error' : ''}"
                 ${fieldError(issues, 'slug') ? 'aria-invalid="true"' : ''}
                 value="${escape(submitted.slug)}">
          ${inlineError(issues, 'slug')}
        </div>`}

        <div class="field">
          <label for="url">Destination URL</label>
          <span class="hint" id="url-hint">Must start with http:// or https://</span>
          <input id="url" name="url" type="url" required maxlength="2048" inputmode="url" spellcheck="false"
                 placeholder="https://"
                 aria-describedby="url-hint${fieldError(issues, 'url') ? ' url-error' : ''}"
                 ${fieldError(issues, 'url') ? 'aria-invalid="true"' : ''}
                 value="${escape(submitted.url)}">
          ${inlineError(issues, 'url')}
        </div>

        <div class="field">
          <label for="description">Description <span class="optional">(optional)</span></label>
          <input id="description" name="description" maxlength="200" value="${escape(submitted.description)}">
          ${inlineError(issues, 'description')}
        </div>

        ${editing && editing.createdBy ? `<p class="hint">Created by ${escape(editing.createdBy)}.</p>` : ''}
        <div class="actions">
          <button type="submit">${editing ? 'Save changes' : 'Create shortcut'}</button>
          ${editing ? '<a href="/">Cancel</a>' : ''}
        </div>
      </form>
    </section>

    <section aria-labelledby="list-heading" class="panel">
      <h2 id="list-heading">Shortcuts</h2>
      <form method="get" action="/" role="search" class="search-form">
        <label for="q">Search shortcuts</label>
        <input id="q" name="q" type="search" value="${escape(view.query)}" placeholder="name, URL or description">
        <button type="submit">Search</button>
        ${view.query ? '<a href="/">Clear</a>' : ''}
      </form>
      ${renderTable(view.shortcuts, view.query)}
    </section>
  `,
  );
};

const renderTable = (shortcuts: readonly Shortcut[], query: string): string => {
  if (shortcuts.length === 0) {
    return `<p class="empty">${
      query
        ? `No shortcuts match <strong>${escape(query)}</strong>.`
        : 'No shortcuts yet. Create the first one above.'
    }</p>`;
  }

  const rows = shortcuts
    .map(
      (shortcut) => `
      <tr>
        <th scope="row"><a href="/${escape(shortcut.slug)}" class="slug">/${escape(shortcut.slug)}</a></th>
        <td><a href="${escape(shortcut.url)}" rel="noreferrer noopener">${escape(truncate(shortcut.url, 64))}</a></td>
        <td>
          ${shortcut.description ? escape(shortcut.description) : '<span class="muted">—</span>'}
          ${shortcut.createdBy ? `<span class="byline">by ${escape(shortcut.createdBy)}</span>` : ''}
        </td>
        <td class="numeric">${shortcut.hits}</td>
        <td>${shortcut.lastAccessedAt ? `<time datetime="${escape(shortcut.lastAccessedAt)}">${escape(shortcut.lastAccessedAt.slice(0, 16).replace('T', ' '))}</time>` : '<span class="muted">never</span>'}</td>
        <td class="row-actions">
          <a href="/?edit=${encodeURIComponent(shortcut.slug)}" aria-label="Edit /${escape(shortcut.slug)}">Edit</a>
          <form method="post" action="/api/shortcuts/${escape(shortcut.slug)}/delete" class="inline-form">
            <button type="submit" class="link-button danger" aria-label="Delete /${escape(shortcut.slug)}">Delete</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  return `
    <table>
      <caption class="visually-hidden">Shortcuts, most used first</caption>
      <thead>
        <tr>
          <th scope="col">Shortcut</th>
          <th scope="col">Destination</th>
          <th scope="col">Description</th>
          <th scope="col" class="numeric">Hits</th>
          <th scope="col">Last used</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
};

/** The 404 page doubles as an entry point: an unknown slug offers to become one. */
export const renderUnknownSlug = (slug: string): string =>
  layout(
    `No shortcut named /${slug}`,
    `
    <h1>No shortcut named <code>/${escape(slug)}</code></h1>
    <p class="lede">Nobody has claimed this one yet.</p>
    <p><a class="button" href="/?slug=${encodeURIComponent(slug)}">Create <code>/${escape(slug)}</code></a></p>
    <p><a href="/">Browse all shortcuts</a></p>
  `,
  );

export const renderProblem = (problem: Problem): string =>
  layout(
    problem.title,
    `
    <h1>${escape(problem.detail)}</h1>
    ${problem.errors?.length ? errorSummary('Details', problem.errors) : ''}
    <p class="muted">Request ID: <code>${escape(problem.requestId)}</code></p>
    <p><a href="/">Back to shortcuts</a></p>
  `,
  );

const fieldError = (issues: readonly FieldIssue[], field: string): FieldIssue | undefined =>
  issues.find((issue) => issue.field === field);

const inlineError = (issues: readonly FieldIssue[], field: string): string => {
  const issue = fieldError(issues, field);
  return issue ? `<p class="field-error" id="${field}-error">${escape(issue.message)}</p>` : '';
};

const errorSummary = (title: string, issues: readonly FieldIssue[]): string => `
  <div class="summary error" role="alert" tabindex="-1" id="error-summary">
    <h2>${escape(title)}</h2>
    <ul>${issues.map((issue) => `<li>${escape(issue.message)}</li>`).join('')}</ul>
  </div>`;

const banner = (message: string): string =>
  `<div class="summary success" role="status">${message}</div>`;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Go Links</title>
  <link rel="icon" href="${FAVICON}">
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <main id="main">${body}</main>
</body>
</html>`;

/** Inlined so the service ships as one file and browsers stop 404-ing on /favicon.ico. */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%231f5f4b'/%3E%3Cpath d='M4 8h6M7.5 5.5 10 8l-2.5 2.5' stroke='%23fff' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const STYLES = `
  :root {
    --bg: #fbfbf9; --panel: #fff; --ink: #1b1b1a; --muted: #6b6b66;
    --line: #e2e2dc; --accent: #1f5f4b; --error: #a1231d; --radius: 6px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--ink);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 56rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin: 0 0 .35rem; }
  h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 1rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; background: #f0f0ea; padding: .1em .3em; border-radius: 3px; }
  .lede { color: var(--muted); margin: 0 0 2rem; max-width: 46rem; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.5rem; margin-bottom: 1.5rem; }
  .field { display: flex; flex-direction: column; margin-bottom: 1.1rem; }
  label { font-weight: 600; margin-bottom: .2rem; }
  .optional, .hint { font-weight: 400; color: var(--muted); font-size: .86rem; }
  .hint { margin-bottom: .4rem; }
  input {
    font: inherit; padding: .55rem .7rem; border: 1px solid var(--line);
    border-radius: var(--radius); background: #fff; color: inherit;
  }
  input:focus-visible, button:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  input[aria-invalid="true"] { border-color: var(--error); }
  button, .button {
    font: inherit; font-weight: 600; padding: .55rem 1.1rem; border: 1px solid var(--accent);
    border-radius: var(--radius); background: var(--accent); color: #fff; cursor: pointer; text-decoration: none;
    display: inline-block;
  }
  button:hover, .button:hover { background: #17493a; }
  .field-error { color: var(--error); font-size: .88rem; margin: .35rem 0 0; }
  .actions { display: flex; gap: 1rem; align-items: center; }
  .byline { display: block; color: var(--muted); font-size: .82rem; }
  .row-actions { white-space: nowrap; }
  .inline-form { display: inline; margin-left: .6rem; }
  .link-button { background: none; border: none; padding: 0; color: var(--accent); font-weight: 400; text-decoration: underline; cursor: pointer; }
  .link-button.danger { color: var(--error); }
  .link-button:hover { background: none; }
  .summary { border: 1px solid; border-radius: var(--radius); padding: .9rem 1.1rem; margin-bottom: 1.5rem; }
  .summary h2 { color: inherit; margin-bottom: .4rem; }
  .summary ul { margin: 0; padding-left: 1.1rem; }
  .summary.error { border-color: var(--error); background: #fdf3f2; color: var(--error); }
  .summary.success { border-color: var(--accent); background: #eef5f2; color: var(--accent); }
  .search-form { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1.2rem; }
  .search-form label { margin: 0; }
  .search-form input { flex: 1 1 16rem; }
  table { width: 100%; border-collapse: collapse; }
  caption { text-align: left; }
  th, td { text-align: left; padding: .6rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  tbody th { font-weight: 600; }
  .slug { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .numeric { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); }
  a { color: var(--accent); }
  .skip-link { position: absolute; left: -999px; }
  .skip-link:focus { left: 1rem; top: 1rem; background: #fff; padding: .5rem .8rem; border: 1px solid var(--accent); border-radius: var(--radius); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16171a; --panel: #1e2024; --ink: #ecebe6; --muted: #9b9b94; --line: #2e3138; --accent: #6fcfae; --error: #f08a84; }
    code { background: #2a2d33; }
    button, .button { color: #10221c; }
    button:hover, .button:hover { background: #8adcc0; }
    .summary.error { background: #2a1b1b; }
    .summary.success { background: #16261f; }
    input { background: #16171a; }
  }
`;
