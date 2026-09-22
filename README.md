# Go Links

An internal URL shortcut service with a companion CLI. `oncall` is easier to
remember than `https://pager.internal/schedules/7f3c/current`, and it keeps
working when the destination moves.

```
POST /api/shortcuts      { "slug": "oncall", "url": "https://pager.internal/rota" }
GET  /oncall             -> 302 https://pager.internal/rota
GET  /jira/ABC-123       -> 302 https://jira.internal/browse/ABC-123

$ go new oncall https://pager.internal/rota
$ go ls
```

Built for the prescreen exercise, Option 1. The git history is deliberately
granular — the first five commits are the hour-one cut (service, UI, tests,
README); everything after is the second pass, so you can judge either on its
own.

---

## Running it

Requires Node 20+ (developed on 22).

```bash
pnpm install       # npm install works too; the committed lockfile is pnpm's
pnpm start         # http://127.0.0.1:3000
```

```bash
pnpm dev           # restarts on change
pnpm test          # 60 tests
pnpm coverage      # ~92% of src, thresholds enforced at 80%
pnpm typecheck
pnpm build         # emits dist/, including the `go` binary
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `GOLINKS_STORE` | `data/shortcuts.json` | Where shortcuts are persisted |
| `LOG_LEVEL` | `info` | pino log level |
| `GOLINKS_SELF_HOSTS` | — | Extra hostnames this service answers on, comma-separated (loop guard) |
| `GOLINKS_ALLOW_PRIVATE_DESTINATIONS` | `false` | Set `true` to permit literal private/loopback IP destinations |
| `GOLINKS_URL` | `http://127.0.0.1:3000` | Server the CLI talks to |
| `GOLINKS_USER` | `$USER` | Identity the CLI sends; recorded as the shortcut's creator |

### Reaching it as `go/`

The brief writes shortcuts as `go/oncall`. Out of the box that is
`http://localhost:3000/oncall`; making the bare word `go` work needs two things
the app cannot do for you — name resolution and a port browsers will assume.

**1. Name.** Point `go` at the machine running the service.

```bash
sudo scripts/setup-go-host.sh          # appends "127.0.0.1 go" to /etc/hosts, idempotent
sudo scripts/setup-go-host.sh remove   # undo
```

On Windows, add the same line to `C:\Windows\System32\drivers\etc\hosts`
from an elevated editor. In an office, this is one internal DNS `A` record
instead.

**2. Port.** Browsers assume port 80. Pick one:

- `PORT=80 pnpm start` — needs root, or on Linux
  `sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"` once.
- A reverse proxy (Caddy, nginx, oauth2-proxy) on 80/443 forwarding to 3000.
  This is the production shape anyway, and the proxy is where identity headers
  come from — see [Ownership](#ownership).
- Skip DNS entirely: add a browser **search keyword** `go` with URL
  `http://localhost:3000/%s`. Typing `go oncall` in the address bar then works
  without touching hosts files. Chrome: Settings → Search engine → Manage;
  Firefox: bookmark `http://localhost:3000/%s` with keyword `go`.

Browsers also treat a single unknown word as a search query the first time.
Type `http://go/oncall` once with the scheme and they remember the host.

### Try it

```bash
curl -X POST localhost:3000/api/shortcuts \
  -H 'content-type: application/json' \
  -d '{"slug":"oncall","url":"https://pager.internal/rota","description":"Current on-call rota"}'

curl -i localhost:3000/oncall            # 302 to the destination
curl 'localhost:3000/api/shortcuts?q=on' # search
```

Or open `http://localhost:3000` — the web UI does the same things.

### The CLI

```bash
pnpm cli new jira https://jira.internal/browse --description "Jira tickets"
pnpm cli edit jira https://jira.internal/projects   # or just --description "..."
pnpm cli ls                     # table, most used first
pnpm cli ls --json | jq         # scriptable
pnpm cli open jira              # launches the browser; --print just prints the URL
pnpm cli rm jira
```

After `pnpm build`, `node dist/cli/index.js` (or `pnpm link --global` → `go`)
runs the same thing without tsx.

```
$ go ls
SHORTCUT  DESTINATION                   HITS  LAST USED
/jira     https://jira.internal/browse  14    2m ago
/oncall   https://pager.internal/rota   3     1h ago
```

Exit codes: `0` success, `1` the server rejected it or was unreachable, `2` the
command line was wrong. Errors go to stderr, so `go ls --json | jq` never sees
a stray message. Server-side validation comes back with the same field detail
the web form shows:

```
$ go new api javascript:x
Error: The shortcut could not be saved.
  slug: That name is reserved by the service.
  url: Only http:// and https:// destinations are allowed.
  request id: 229db21b-57d3-428c-bd60-efcf81b5983e
```

---

## The API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Directory UI: create form, search, list |
| `GET` | `/:slug` | **302** to the destination, counts the hit |
| `GET` | `/:slug/*` | Same, with the suffix appended to the destination path |
| `POST` | `/api/shortcuts` | Create. Accepts JSON or form-encoded |
| `GET` | `/api/shortcuts?q=` | List, optionally filtered |
| `GET` | `/api/shortcuts/:slug` | Fetch one |
| `PUT` | `/api/shortcuts/:slug` | Change the URL and/or description. `POST` is accepted for the HTML form |
| `DELETE` | `/api/shortcuts/:slug` | Remove one. `POST …/:slug/delete` for the HTML form |
| `GET` | `/healthz` | Liveness, shortcut count, uptime |
| `GET` | `/metrics` | Prometheus exposition |

Path suffixes let one shortcut front a whole tree: with `jira` pointing at
`https://jira.internal/browse`, `/jira/ABC-123?focus=1` redirects to
`https://jira.internal/browse/ABC-123?focus=1`. Dot segments are dropped and
each segment is re-encoded, so a suffix cannot climb out of the destination path
or smuggle in a second query string.

Errors are [RFC 7807](https://www.rfc-editor.org/rfc/rfc7807) problem documents,
with field-level detail where it exists:

```json
{
  "type": "https://golinks.internal/problems/validation_failed",
  "title": "validation_failed",
  "status": 400,
  "detail": "The shortcut could not be saved.",
  "requestId": "5814961b-056c-4bc8-9238-4862e300a191",
  "errors": [
    { "field": "slug", "message": "That name is reserved by the service." },
    { "field": "url", "message": "Only http:// and https:// destinations are allowed." }
  ]
}
```

The same `requestId` is on the response header and in every log line for that
request, so a user-reported failure can be found in the logs directly.

### What a shortcut may point at

Three checks run on create and on edit, in [`core/destination.ts`](src/core/destination.ts):

| Check | Why |
|---|---|
| Scheme is `http` or `https` | `javascript:` / `data:` would make the directory a stored-XSS host |
| Host is not the service itself | `go/a → http://go/a` bounces a browser until it gives up. The request's own `Host` header is always in the deny set, plus `go`, `localhost`, `127.0.0.1` and anything in `GOLINKS_SELF_HOSTS` |
| Host is not a literal private, loopback, link-local or cloud-metadata address | `169.254.169.254`, `10.x`, `[::1]`, `metadata.google.internal` and friends. The server never fetches destinations itself, so this is not SSRF in the strict sense — but a durable, shareable link into a metadata endpoint is still a pivot you would rather not host |

Hostnames are **not** resolved. Internal tools point at internal hostnames by
definition; a DNS-based check would block the whole use case and would be a
time-of-check/time-of-use race anyway. Operators who genuinely need literal
private IPs set `GOLINKS_ALLOW_PRIVATE_DESTINATIONS=true`.

### Ownership

Each shortcut records `createdBy`. There is no login; identity arrives as a
header — `x-forwarded-user` / `x-forwarded-email` from an SSO proxy such as
oauth2-proxy, or `x-golinks-user` from the CLI (`GOLINKS_USER`, defaulting to
`$USER`).

The rule is an **accident guard, not access control**: a shortcut with no
recorded owner, or a caller with no identity, is never blocked. Only a *known
stranger* gets a `403 not_owner`. Anyone can send the header, so this stops
teammates from stepping on each other by mistake, and nothing more. Real
enforcement means the proxy strips inbound identity headers and sets its own —
at which point the same code becomes trustworthy without changing.

### Observability

- **Structured logs** (pino) with the request ID on every line; one line per
  shortcut hit, miss, create and delete.
- **`/metrics`** — `golinks_redirects_total{outcome="hit"|"miss"}`,
  `golinks_shortcuts`, `golinks_http_request_duration_seconds` by route pattern
  and status, plus Node process defaults. Slug is deliberately *not* a metric
  label: users mint slugs, so it would be unbounded cardinality. Per-slug
  numbers live in the store instead.
- **`/healthz`** for liveness.
- **Per-shortcut `hits` and `lastAccessedAt`** in the store, surfaced in the UI
  and CLI.

---

## How it is put together

```
src/
├── core/                 no HTTP in here
│   ├── errors.ts         Validation / Conflict / Forbidden / NotFound
│   ├── shortcut.ts       the model, create/update validation, ownership, suffix resolution
│   ├── destination.ts    loop and private-address rules for destinations
│   └── repository.ts     ShortcutRepository + in-memory and JSON-file impls
├── server/
│   ├── app.ts            Fastify wiring: request IDs, timing, /metrics, error handler
│   ├── routes.ts         the routes above
│   ├── identity.ts       who is asking, from proxy or CLI headers
│   ├── problem.ts        errors -> problem+json or HTML, in one place
│   ├── metrics.ts        Prometheus registry and instruments
│   └── views.ts          server-rendered HTML, create and edit modes
├── cli/
│   ├── index.ts          argument parsing, commands, exit codes
│   ├── client.ts         fetch wrapper that understands problem+json
│   └── format.ts         table output
└── scripts/
    └── setup-go-host.sh  maps `go` to localhost in /etc/hosts
```

Three decisions shape the rest:

**`core` knows nothing about HTTP.** Validation, the error taxonomy, storage and
suffix resolution are testable without a server, and a slug is validated
identically whether it arrives from the form, the JSON API, or the CLI.

**Errors are values, not strings.** Every deliberate failure is an `AppError`
carrying its status and a stable `code`. One handler turns those into
problem+json or an HTML page. Handlers never assemble error payloads, and an
unexpected exception can only ever produce a generic 500 — it cannot leak a
stack trace to a caller. The CLI reads the same problem documents back into a
typed `ApiError`, so the whole system has one error vocabulary.

**Storage is behind an interface.** `ShortcutRepository` has two
implementations: in-memory (used by every test) and JSON-file (used when you run
it). Swapping in Postgres is one new class, no changes above it.

---

## Assumptions

- **Internal, behind a proxy that knows who you are.** No login of its own. The
  brief says not to add auth, and go-links services in practice live behind SSO
  proxies that already inject identity headers. This service reads those, records
  who did what, and uses it as a courtesy guard — see [Ownership](#ownership).
- **Single process.** The JSON store assumes one writer. Writes go to a temp file
  and are renamed over the target, which is atomic on POSIX, so a crash mid-write
  cannot corrupt the file — but two processes sharing a file would race.
- **Small by nature.** An internal link directory is hundreds of rows, not
  millions, so the whole set is held in memory and searched with `includes`. That
  assumption is what makes the file store reasonable.
- **Shortcuts are mutable.** Destinations change, so redirects are `302` with
  `cache-control: no-store`, never `301`. A permanent redirect would be cached by
  browsers long after the destination moved, and there is no way to recall it.
- **Slugs are case-insensitive** and normalised to lowercase. `/OnCall` and
  `/oncall` are the same shortcut; typing a URL in a hurry should still work.
- **Stores upgrade in place.** A file written before `lastAccessedAt` existed is
  read fine — missing fields default on load. Schema changes should not require
  a migration step for a tool this small.

## Tradeoffs I chose on purpose

**No client-side JavaScript.** The product is a form, a table and a redirect.
Server-rendered HTML with a plain form means no build step, no bundle, no
hydration, and it works with JS disabled. A `POST` that succeeds replies `303`
to the list page so a refresh cannot double-submit; a `POST` that fails re-renders
the form with the user's input intact and errors attached to the offending
fields. That is meaningfully better UX than the SPA I would have had time to
build in the same hour.

**The CLI has no dependencies.** `node:util.parseArgs` and global `fetch` are
enough for five commands. Commander or yargs would be right at ten commands with
nested options; at five they are more surface than the tool. The CLI is tested
against a real listening server on an ephemeral port, not a mocked `fetch` —
the contract under test is the wire format, and a mock would only prove the CLI
agrees with itself.

**Validation in the domain, not in a schema plugin.** Fastify can validate from
JSON Schema, but then the HTML form path would need its own rules. One zod schema
in `core` serves the form, the API and the CLI, and its messages are written to
be read by a person (`"Use lowercase letters, numbers and hyphens only"`) rather
than by a linter.

**Reserved slugs are a domain rule.** `api`, `healthz`, `health`, `metrics` and friends
live in `RESERVED_SLUGS` in `core`, not in the router. Shortcuts share a
namespace with the service's own routes, and that constraint belongs with the
model.

**Only `http`/`https` destinations.** A shortcut is a redirect someone else will
click. Allowing `javascript:` or `data:` would turn the directory into a
convenient phishing host, so the scheme is allow-listed rather than
deny-listed. There is a test for it — and one for `../` in a path suffix.

**Hit counting is fire-and-forget.** The counter is analytics, not part of the
redirect contract. A failed write is logged and dropped rather than made into the
user's problem.

**Tests target behaviour, not implementation.** 60 tests across validation,
destination rules, the repository, the HTTP surface and the CLI — including that
user input is escaped rather than rendered as markup, that a failed form keeps
your input, that a suffix cannot escape its destination, and that a known
stranger cannot edit your shortcut while an anonymous caller still can. There are no tests asserting on internal
function calls, because those are the tests that make refactoring expensive.

**Accessibility is in the markup, not bolted on.** Labelled inputs with hint text
wired through `aria-describedby`, `aria-invalid` on failed fields, an error
summary with `role="alert"`, a skip link, visible focus rings, a real `<table>`
with scoped headers, and a dark mode that respects `prefers-color-scheme`. Almost
free when the HTML is written by hand; expensive to retrofit later.

## What I would do next

Roughly in the order I would pick them up:

1. **Real identity.** Ownership today trusts a header. The next step is a proxy
   that sets it (oauth2-proxy in front, stripping inbound copies) — no code
   change here, but the deployment shape that makes `createdBy` mean something.
   After that: teams as owners, not just people.
2. **Postgres behind the existing interface.** The moment there are two processes,
   the file store is wrong. `ShortcutRepository` is already the seam; the
   in-memory implementation keeps the test suite fast either way.
3. **Stale link detection.** A background check for destinations returning 404 or
   timing out, surfaced in the UI and as a metric. A link directory's real
   failure mode is quiet rot, not downtime.
4. **Miss telemetry.** Misses are counted and logged today. Aggregating *which*
   slugs people try tells you what they expect to exist — the best possible
   backlog for a tool like this.
5. **CLI distribution.** Right now it is `pnpm build` and a `bin` entry. A real
   rollout is a standalone binary per platform plus a Homebrew tap, with an
   update check — worth doing once more than a handful of people use it.

## What I did not build, and why

A login system, Docker, CI/CD, rate limiting, an ESLint config, a bulk importer,
DNS-resolving destination checks, and a JS-driven UI. Each is defensible in production and none of them would have
told you anything about how I make decisions that this README does not. The brief
asked for restraint, so the effort went into validation, error handling,
accessibility, observability and tests instead.
