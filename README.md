# @pipeworx/oig-corporate-integrity

HHS-OIG Corporate Integrity Agreements — does this healthcare company or
individual have a Corporate Integrity Agreement (CIA), since when, what
obligations does it impose, and what is its current status? A CIA is a
**different condition from an exclusion** (see the `leie` and
`ny-omig-exclusions` packs): an entity under a CIA is still participating in
Medicare/Medicaid, under binding compliance obligations OIG negotiated
instead of seeking exclusion.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `oig_cia_check(name, limit?)` — checks an entity against the current
  HHS-OIG CIA roster. An exact name match is the strongest signal; a
  normalized-name or token match is returned as a labelled **candidate**,
  since CIA entity names are frequently compound (a company plus named
  co-signers, e.g. "SNAP Diagnostics, LLC and Gil Raviv"). For the best
  match, fetches the entity's own detail page **live** to return the
  effective date, term/duration, settlement amount and the agreement PDF
  URL — none of that is baked, so it is never stale. Returns `found: false`
  with the list's as-of date and total agreement count when no match exists.
- `oig_cia_obligations(name?, document_url?)` — resolves the entity (same
  matching as `oig_cia_check`) or takes a `document_url` directly, fetches
  the agreement PDF **live** from oig.hhs.gov, extracts its text, and
  reports which of six obligation categories (Board Resolution, Independent
  Review Organization/IRO reviews, Compliance Officer/Committee, Annual or
  Implementation reporting, a disclosure program, excluded-persons
  screening) actually appear in the text, each with a short excerpt. Not
  every CIA includes every category — a sole-individual CIA typically has no
  Board Resolution clause — and some older, fully closed agreements have no
  PDF posted at all, reported as `found: false`, not an error.
- `oig_cia_list(status?, limit?, offset?)` — browses the baked CIA list by
  status (`Effective` / `Suspended` / `Closed` / `Refused`). Fast (no live
  fetch), but carries only what the list card shows — call `oig_cia_check`
  on a specific entity for effective date, term and the agreement document.

## Auth

Keyless.

## Data sources

- <https://oig.hhs.gov/compliance/corporate-integrity-agreements/browse-cias/>
  — the paginated, filterable CIA roster (339 agreements as captured, 20 per
  page). No JSON/REST endpoint and no bulk CSV/Excel export exist.
- Each agreement's own detail page
  (`/compliance/corporate-integrity-agreements/browse-cias/<slug>/`) —
  effective date, term, settlement amount, category/tags, and the agreement
  PDF's URL. Fetched live, per call, never baked.
- The agreement PDF itself (`oig.hhs.gov/documents/cias/<id>/<file>.pdf`) —
  text PDFs, extracted with `shared/src/pdf-text.ts`.

### Why only the LIST is baked

Root CLAUDE.md's standing rule for this shape: a baked table never sits in
gateway module scope. `scripts/bake-index.mjs` crawls all 17 pages of the
browse list and bakes only the entity name, detail-page path, the status
badge/date shown on the list card, location and report type — into
`src/oig-cia-index-data.ts`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy, and
injected as `args._bakedIndex` (fleet #2754 pattern, same as
`south-dakota-code` / `ny-omig-exclusions` / `usgs-mineral-commodities`). A
missing or malformed injection throws loudly rather than answering "no CIA
found" — see `src/index.test.ts`.

Per-entity detail (effective date, term, settlement amount, the agreement
PDF URL and its text) is **deliberately not baked** — it is fetched live
from that one entity's own detail page and PDF on every `oig_cia_check` /
`oig_cia_obligations` call. Most callers never ask about most of the 339
rows, so pre-crawling all of them would be wasted work; fetching live also
means a newly-closed or newly-suspended agreement is visible immediately
instead of waiting for the next bake.

Re-run `node mcps/oig-corporate-integrity/scripts/bake-index.mjs`
periodically to refresh the list and recommit. OIG's own page carries no
static freshness banner ("As of today") — `data_as_of` on every response is
simply the bake script's own capture date.

### Transport/parse failures throw loud

A non-200 from a detail page or PDF, or a 200 whose content no longer
matches the shape this pack parses, is reported as a thrown error naming the
upstream status — never silently reshaped into `found: false`, which for a
compliance screening tool would be indistinguishable from "no CIA on file".
See `src/index.test.ts` for the stubbed-fetch contract tests.

### Reachability

Verified live 2026-10-07 from both a laptop fetch and a throwaway
`wrangler dev --remote` Worker on the prod Cloudflare account: identical
`200` responses and byte lengths from the Cloudflare edge on the browse
list, a detail page and an agreement PDF (92,934 / 44,393 / 696,577 bytes
respectively). This host has no `robots.txt` at all (404).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "oig-corporate-integrity": {
      "url": "https://gateway.pipeworx.io/oig-corporate-integrity/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/oig-corporate-integrity/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/oig_cia_check \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alliance Parent, Inc."}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/oig_cia_check`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-oig-corporate-integrity` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/oig-corporate-integrity/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "oig-corporate-integrity": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-oig-corporate-integrity"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Oig Corporate Integrity data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
