#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiError, GoLinksClient } from './client.js';
import { renderTable } from './format.js';

/**
 * `go` — command-line client for the Go Links service.
 *
 *   go new <slug> <url> [--description "..."]
 *   go edit <slug> [url] [--description "..."]
 *   go ls [query] [--json]
 *   go get <slug> [--json]
 *   go rm <slug>
 *   go open <slug> [--print]
 *
 * Exit codes: 0 success, 1 the server rejected or could not be reached,
 * 2 the command line itself was wrong. Human output goes to stdout; every
 * error goes to stderr so `go ls --json | jq` never sees a stray message.
 */

const USAGE = `Usage:
  go new <slug> <url> [--description <text>]   Create a shortcut
  go edit <slug> [url] [--description <text>]  Change the destination or description
  go ls [query] [--json]                       List shortcuts, most used first
  go get <slug> [--json]                       Show one shortcut
  go rm <slug>                                 Delete a shortcut
  go open <slug> [--print]                     Open in the browser (or just print the URL)

Environment:
  GOLINKS_URL    Server base URL (default http://127.0.0.1:3000)
  GOLINKS_USER   Identity recorded on shortcuts you create (default: $USER)`;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export const run = async (argv: readonly string[], client: GoLinksClient): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      print: { type: 'boolean', default: false },
      description: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }

  switch (command) {
    case 'new': {
      const [slug, url] = rest;
      if (!slug || !url) return usage('go new needs a slug and a URL.');
      const shortcut = await client.create({
        slug,
        url,
        ...(values.description ? { description: values.description } : {}),
      });
      console.log(`Created /${shortcut.slug} -> ${shortcut.url}`);
      return EXIT_OK;
    }
    case 'edit': {
      const [slug, url] = rest;
      if (!slug) return usage('go edit needs a slug.');
      if (!url && values.description === undefined) {
        return usage('go edit needs a new URL, a --description, or both.');
      }
      const shortcut = await client.update(slug, {
        ...(url ? { url } : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
      });
      console.log(`Updated /${shortcut.slug} -> ${shortcut.url}`);
      return EXIT_OK;
    }
    case 'ls': {
      const shortcuts = await client.list(rest[0]);
      console.log(values.json ? JSON.stringify(shortcuts, null, 2) : renderTable(shortcuts));
      return EXIT_OK;
    }
    case 'get': {
      if (!rest[0]) return usage('go get needs a slug.');
      const shortcut = await client.get(rest[0]);
      console.log(values.json ? JSON.stringify(shortcut, null, 2) : renderTable([shortcut]));
      return EXIT_OK;
    }
    case 'rm': {
      if (!rest[0]) return usage('go rm needs a slug.');
      await client.remove(rest[0]);
      console.log(`Deleted /${rest[0]}`);
      return EXIT_OK;
    }
    case 'open': {
      if (!rest[0]) return usage('go open needs a slug.');
      const shortcut = await client.get(rest[0]);
      if (values.print) {
        console.log(shortcut.url);
      } else {
        openInBrowser(shortcut.url);
        console.error(`Opening ${shortcut.url}`);
      }
      return EXIT_OK;
    }
    default:
      return usage(`Unknown command "${command}".`);
  }
};

const usage = (message: string): number => {
  console.error(`${message}\n\n${USAGE}`);
  return EXIT_USAGE;
};

const openInBrowser = (url: string): void => {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
};

const reportFailure = (error: unknown): void => {
  if (error instanceof ApiError) {
    console.error(`Error: ${error.message}`);
    for (const issue of error.issues) console.error(`  ${issue.field}: ${issue.message}`);
    if (error.requestId) console.error(`  request id: ${error.requestId}`);
    return;
  }
  const cause = error instanceof Error ? error.message : String(error);
  console.error(`Error: could not reach the Go Links server (${cause}). Is it running? Set GOLINKS_URL if not local.`);
};

// Only run when executed directly — not when a test imports `run`. Resolving
// the real path means the `go` bin symlink is recognised too.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  const identity = process.env.GOLINKS_USER ?? process.env.USER ?? process.env.USERNAME ?? null;
  const client = new GoLinksClient(process.env.GOLINKS_URL ?? 'http://127.0.0.1:3000', identity);
  run(process.argv.slice(2), client)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      reportFailure(error);
      process.exit(EXIT_FAILED);
    });
}
