import type { Shortcut } from '../core/shortcut.js';

/** Fixed-width table for humans. `--json` bypasses this entirely. */
export const renderTable = (shortcuts: readonly Shortcut[]): string => {
  if (shortcuts.length === 0) return 'No shortcuts.';

  const rows = shortcuts.map((shortcut) => [
    `/${shortcut.slug}`,
    shortcut.url,
    String(shortcut.hits),
    shortcut.lastAccessedAt ? relative(shortcut.lastAccessedAt) : 'never',
  ]);
  const header = ['SHORTCUT', 'DESTINATION', 'HITS', 'LAST USED'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();

  return [line(header), ...rows.map(line)].join('\n');
};

const relative = (iso: string, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};
