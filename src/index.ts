interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Minimal text extractor for simple, text-based PDFs — the kind a
 * mail-merge/print pipeline produces (Word or LibreOffice "export to PDF"),
 * not a scanned image. Built for Kentucky's per-statute PDFs
 * (apps.legislature.ky.gov/law/statutes/statute.aspx?id=...), which ARE
 * exactly that shape: one object tree, FlateDecode content streams, standard
 * TrueType fonts. This is the capability the state-law survey flagged as
 * "the largest single win available" (docs/state-law-probe.md) — several
 * state statute sites serve text ONLY as a per-section PDF, with no HTML
 * fallback, and until now this repo had no way to read one.
 *
 * WHAT THIS DOES NOT DO: parse a general PDF. No encryption, no cross-
 * reference recovery for a damaged file, no image/OCR, no custom
 * `/Differences` glyph encodings, no LZW or RunLength filters, no multi-byte
 * codespaces other than the 2-byte one every sampled font used. Most objects
 * this needs — Catalog, Pages, a leaf Page, its Resources/Font dict, its
 * Contents stream(s), a Type0 font's ToUnicode CMap — are found by scanning
 * for `N 0 obj ... endobj` directly in the file bytes. If a producer moves
 * one into a compressed object stream and this extractor still cannot find
 * it (see the next paragraph for what IS handled), extraction degrades to
 * `pages_found: 0` / empty text rather than silently returning garbage —
 * check `warnings` before trusting a thin result.
 *
 * COMPRESSED OBJECT STREAMS (`/Type/ObjStm`) ARE SUPPORTED (fleet #2744,
 * added for Wyoming's statute PDFs, which — unlike Kentucky's — are
 * cross-reference-STREAM files whose Catalog and Pages root are themselves
 * compressed into an ObjStm: `5205 0 obj` never appears literally in the
 * file; it exists only as entry in a decompressed `/Type/ObjStm` stream).
 * Every direct `/Type/ObjStm` object found in the file is inflated up front;
 * its header (`/N` object pairs starting at byte `/First`) is parsed into a
 * `(object number -> dict text)` map, and `getObject` falls back to that map
 * whenever the direct byte-scan finds nothing. Per the PDF spec a compressed
 * object can never itself contain a stream (Contents, ToUnicode CMaps, and
 * ObjStm/XRef streams are therefore always direct objects, found the
 * original way) — so this fallback only ever needs to resolve plain
 * dictionaries/arrays (Catalog, Pages, Font, sometimes Page), which is
 * exactly what Wyoming's shape needs. An ObjStm nested inside another
 * ObjStm via `/Extends` is NOT walked — not observed in any file tested.
 *
 * ALSO FIXED HERE: the Catalog/Pages discovery no longer requires `/Type`
 * to be the first thing found after `<<` in a Catalog's own dictionary text
 * — the original `<<[^>]*\/Type\s*\/Catalog` regex broke the moment any
 * NESTED dict (e.g. `/MarkInfo<</Marked true>>`) appeared earlier in the
 * same object, because `[^>]*` cannot cross that inner `>>`. Wyoming's real
 * Catalog objects are exactly this shape (`/Lang(...)/MarkInfo<<...>>
 * /Metadata .../Pages .../Type/Catalog/ViewerPreferences<<...>>`, `/Type`
 * nowhere near the start). Discovery now finds `/Type/Catalog` (or
 * `/Type/Pages`) as plain text anywhere — direct or inside a decompressed
 * ObjStm — and locates its OWN object number by nearest preceding
 * `N 0 obj` marker, which works regardless of what else is in the dict.
 *
 * TWO FONT SHAPES, BOTH NEEDED (confirmed against real KRS statute PDFs,
 * fleet #2734):
 *   - Simple TrueType/Type1 with `/Encoding/WinAnsiEncoding` — the common
 *     case. WinAnsiEncoding is BY DESIGN identical to Windows code page 1252
 *     (that is what "WinAnsi" means), so the raw string-literal bytes decode
 *     directly via `TextDecoder('windows-1252')` with no per-glyph table of
 *     our own to get wrong.
 *   - Type0/CIDFontType2 with `/Encoding/Identity-H` — seen even inside an
 *     otherwise-simple statute, apparently whenever the PDF producer's text
 *     shaping fell back to a subset-embedded font for one run (KRS 532.025's
 *     closing sentence, which includes a curly apostrophe, was entirely in
 *     this font while the rest of the document used WinAnsi). Each character
 *     is a 2-byte CID with NO inherent meaning; the `/ToUnicode` CMap
 *     attached to the font is the only place the real Unicode value lives
 *     (`beginbfchar`/`beginbfrange` blocks). Skipping this font shape would
 *     have truncated or corrupted exactly the statutes that happen to use a
 *     special character — not a rare edge case, a silent one.
 *
 * Verified end-to-end against two real KRS statutes during this pack's
 * build: a single-page WinAnsi-only PDF (507.020, Murder) and a four-page PDF
 * mixing both font shapes (532.025, including the CID-encoded sentence
 * naming "Kimber's Law") — both reproduced the statute's true text exactly,
 * eyeballed against the rendered PDF.
 *
 * INDIRECT /Length (fleet #2743): extended for North Dakota's Century Code
 * chapter PDFs (ndlegis.gov/cencode/t*.pdf), whose content streams all write
 * `/Length` as an indirect reference ("/Length 3 0 R") rather than inlining
 * the literal integer the way every sampled KRS PDF did. The referenced
 * object is resolved (it is always a bare integer object, never itself a
 * stream) rather than falling back to scanning for the "endstream" keyword —
 * that fallback slices in the EOL bytes between the compressed data and the
 * keyword, which this repo's own Node zlib rejects as "trailing junk" even
 * though the compressed payload is intact (Workers' DecompressionStream may
 * be more lenient, but Node is what `prepush-tests.mjs` runs, so the bug was
 * real either way). Verified against ND Century Code chapter 12.1-16
 * (Homicide, t12-1c16.pdf) — every content stream in that 9-page PDF uses
 * the indirect form.
 */

interface PdfExtractResult {
  /** Extracted text, pages joined with a blank line. Empty string if nothing
   *  could be read — check `warnings`, not just truthiness, before deciding
   *  that means the document has no text. */
  text: string;
  /** Number of leaf /Type/Page objects found via the Pages tree. */
  pages: number;
  /** Non-fatal problems found while extracting (unknown font, missing
   *  ToUnicode, etc). A non-empty array does not mean the text is wrong, but
   *  it means something was guessed rather than read. */
  warnings: string[];
}

type FontDecoder =
  | { kind: 'winansi' }
  | { kind: 'cid'; map: Map<number, number> }
  // Simple (1-byte-code) font decoded via its own /ToUnicode CMap rather than
  // WinAnsi — see fontDecoderFor's comment on North Dakota's subsetted fonts.
  | { kind: 'mapped1'; map: Map<number, number> };

/** Inflate one `/FlateDecode` stream using the platform's own zlib — no
 *  dependency, works identically in the Workers runtime and in Node (used by
 *  this repo's prepush tests), because both implement the standard
 *  CompressionStream/DecompressionStream API over the zlib wire format PDF's
 *  FlateDecode filter already uses. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Undo PDF string-literal escaping — `\(`, `\)`, `\\`, `\n`/`\r`/`\t`,
 * octal `\ddd`, and a trailing backslash-newline line continuation — on a
 * windows-1252-decoded slice. Safe to run on the decoded string rather than
 * raw bytes: every character this function inspects or produces (backslash,
 * parens, digits, the letters n/r/t/b/f) is plain ASCII, which windows-1252
 * never remaps, so the 1-byte-per-character alignment this relies on holds
 * throughout.
 */
function unescapePdfLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[i + 1];
    if (next === undefined) continue;
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b' || next === 'f') { i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next >= '0' && next <= '7') {
      let oct = next, j = i + 1, k = 0;
      while (k < 2 && s[j + 1] >= '0' && s[j + 1] <= '7') { j++; oct += s[j]; k++; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j;
    } else if (next === '\n') { i++; }
    else if (next === '\r') { i++; if (s[i + 1] === '\n') i++; }
    else { out += next; i++; }
  }
  return out;
}

interface RawObject {
  dict: string;
  streamBytes: Uint8Array | null;
}

/** Extract readable text from a simple, non-encrypted, non-scanned PDF. */
async function extractPdfText(buf: ArrayBuffer): Promise<PdfExtractResult> {
  const bytes = new Uint8Array(buf);
  // windows-1252 decode is total (every byte maps to exactly one UTF-16 code
  // unit) and length-preserving, so a match index found in `scan` is also a
  // valid BYTE offset into `bytes` — used below to slice stream data without
  // ever routing binary bytes through a lossy string round-trip.
  const scan = new TextDecoder('windows-1252').decode(bytes);
  const warnings: string[] = [];
  const objCache = new Map<number, RawObject | null>();

  // Byte offset of every DIRECT "N 0 obj" marker, sorted, for two uses: (1)
  // the object-lookup fallback stays regex-per-object the same as before;
  // (2) `objNumBefore` below answers "which object's text is this index
  // inside", which is how Catalog/Pages/ObjStm discovery works regardless of
  // what else that object's dictionary contains — see the file header.
  const objStarts: { index: number; num: number }[] = [];
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function getDirectObject(n: number): RawObject | null {
    if (objCache.has(n)) return objCache.get(n) ?? null;
    const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
    const m = re.exec(scan);
    if (!m) { objCache.set(n, null); return null; }
    const objStart = m.index + m[0].length;
    const endobjIdx = scan.indexOf('endobj', objStart);
    const streamIdx = scan.indexOf('stream', objStart);
    let dict: string;
    let streamBytes: Uint8Array | null = null;
    if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
      dict = scan.slice(objStart, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      // Matches EITHER "/Length 428" (literal) or "/Length 12 0 R"
      // (indirect) — group 2 is present only for the indirect form. Written
      // this way ON PURPOSE instead of the more obvious
      // `/\/Length\s+(\d+)(?!\s+0\s+R)/` for a literal: that negative
      // lookahead is a backtracking trap for any MULTI-DIGIT indirect
      // reference. On "/Length 12 0 R", a greedy `(\d+)` first tries "12",
      // the lookahead correctly forbids it (followed by " 0 R") — but the
      // engine then backtracks `\d+` down to "1", at which point the
      // lookahead is checked against "2 0 R", which does NOT start with
      // whitespace, so the forbidden pattern no longer matches and the
      // lookahead (wrongly) PASSES. The match silently becomes "1" instead
      // of failing, so this object's /Length reads as the literal integer 1
      // instead of as a reference to resolve — exactly the shape of North
      // Dakota's Century Code chapter PDFs (fleet #2743), whose indirect
      // Length refs are almost all two or more digits. An explicit optional
      // group has nothing to backtrack: `(\d+)` greedily keeps "12" and the
      // optional `(\s+0\s+R)?` either matches right after it or doesn't.
      const lenDictMatch = /\/Length\s+(\d+)(\s+0\s+R)?/.exec(dict);
      let dataEnd = -1;
      if (lenDictMatch) {
        if (!lenDictMatch[2]) {
          dataEnd = dataStart + parseInt(lenDictMatch[1], 10);
        } else {
          // Indirect reference. The referenced object is a bare integer
          // ("12 0 obj\n4541\nendobj"), never itself a stream, so resolving
          // it through the same getObject() is safe (no recursion risk back
          // onto object n). Falling back to scanning for the "endstream"
          // keyword instead — which the pre-fix code did unconditionally
          // here — slices in the EOL bytes PDF producers place between the
          // compressed data and that keyword, which Node's strict zlib
          // rejects as "trailing junk" even though the compressed payload
          // itself is intact.
          const lenObj = getObject(parseInt(lenDictMatch[1], 10));
          const lenVal = lenObj ? parseInt(lenObj.dict.trim(), 10) : NaN;
          if (Number.isFinite(lenVal) && lenVal >= 0) dataEnd = dataStart + lenVal;
        }
      }
      if (dataEnd === -1) dataEnd = scan.indexOf('endstream', dataStart);
      streamBytes = bytes.slice(dataStart, dataEnd);
    } else {
      dict = scan.slice(objStart, endobjIdx === -1 ? scan.length : endobjIdx);
    }
    const result = { dict, streamBytes };
    objCache.set(n, result);
    return result;
  }

  // Compressed objects (inside a /Type/ObjStm) — object number -> dict text.
  // Populated below, before any Catalog/Pages/Font lookup runs, because a
  // compressed Catalog or Pages root (Wyoming's shape) must resolve exactly
  // like a direct one from that point on. Never holds a stream: the PDF spec
  // forbids a compressed object from containing one.
  const compressedObjects = new Map<number, string>();
  {
    const objStmNums: number[] = [];
    const re = /\/Type\s*\/ObjStm\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      const n = objNumBefore(m.index);
      if (n !== null) objStmNums.push(n);
    }
    for (const n of objStmNums) {
      const obj = getDirectObject(n);
      if (!obj || !obj.streamBytes) { warnings.push(`ObjStm ${n} has no stream data`); continue; }
      let data: Uint8Array;
      if (/\/Filter\s*\/FlateDecode/.test(obj.dict)) {
        try {
          data = await inflate(obj.streamBytes);
        } catch (e) {
          warnings.push(`inflate failed for ObjStm ${n}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      } else {
        data = obj.streamBytes;
      }
      const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
      const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
      if (!nMatch || !firstMatch) { warnings.push(`ObjStm ${n} missing /N or /First`); continue; }
      const count = parseInt(nMatch[1], 10);
      const first = parseInt(firstMatch[1], 10);
      const header = new TextDecoder('latin1').decode(data.slice(0, first)).trim().split(/\s+/).map((x) => parseInt(x, 10));
      const entries: { num: number; offset: number }[] = [];
      for (let i = 0; i + 1 < header.length && entries.length < count; i += 2) {
        entries.push({ num: header[i], offset: header[i + 1] });
      }
      const body = new TextDecoder('windows-1252').decode(data);
      for (let i = 0; i < entries.length; i++) {
        const start = first + entries[i].offset;
        const end = i + 1 < entries.length ? first + entries[i + 1].offset : data.length;
        if (start < 0 || end > data.length || start > end) {
          warnings.push(`ObjStm ${n} entry ${entries[i].num} has an out-of-range offset, skipped`);
          continue;
        }
        compressedObjects.set(entries[i].num, body.slice(start, end));
      }
    }
  }

  // The lookup every caller below actually uses: direct object text, falling
  // back to a compressed one. Never both — a given object number is either
  // found literally in the file or inside exactly one ObjStm, not both.
  function getObject(n: number): RawObject | null {
    const direct = getDirectObject(n);
    if (direct) return direct;
    const compressed = compressedObjects.get(n);
    if (compressed !== undefined) return { dict: compressed, streamBytes: null };
    return null;
  }

  async function decompressedStream(n: number): Promise<Uint8Array | null> {
    const obj = getObject(n);
    if (!obj || !obj.streamBytes) return null;
    if (/\/FlateDecode/.test(obj.dict)) {
      try {
        return await inflate(obj.streamBytes);
      } catch (e) {
        warnings.push(`inflate failed for object ${n}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
    return obj.streamBytes;
  }

  // Catalog -> Pages -> Kids, walked in document order. Falls back to the
  // first /Type/Pages object if no /Type/Catalog is found. Both searches
  // look for the TYPE MARKER as plain text first (direct text, or inside any
  // decompressed ObjStm body) and then find which object that text belongs
  // to — see the file header for why this replaced a single greedy regex.
  let pagesRef: number | null = null;
  function findObjWithType(typeName: string): number | null {
    const directIdx = scan.search(new RegExp(`/Type\\s*/${typeName}\\b`));
    if (directIdx !== -1) {
      const n = objNumBefore(directIdx);
      if (n !== null) return n;
    }
    const typeRe = new RegExp(`/Type\\s*/${typeName}\\b`);
    for (const [num, text] of compressedObjects) {
      if (typeRe.test(text)) return num;
    }
    return null;
  }
  const catNum = findObjWithType('Catalog');
  if (catNum !== null) {
    const catObj = getObject(catNum);
    const pm = catObj ? /\/Pages\s+(\d+)\s+0\s+R/.exec(catObj.dict) : null;
    if (pm) pagesRef = parseInt(pm[1], 10);
  }
  if (pagesRef === null) {
    pagesRef = findObjWithType('Pages');
  }

  const leafPages: number[] = [];
  function walkPages(n: number, depth: number): void {
    if (depth > 12) { warnings.push('Pages tree exceeded depth 12, stopped walking'); return; }
    const obj = getObject(n);
    if (!obj) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(obj.dict)) { leafPages.push(n); return; }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
    if (!kidsMatch) return;
    for (const km of kidsMatch[1].matchAll(/(\d+)\s+0\s+R/g)) walkPages(parseInt(km[1], 10), depth + 1);
  }
  if (pagesRef !== null) walkPages(pagesRef, 0);
  else warnings.push('no /Type/Catalog or /Type/Pages object found');

  /** Parse a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks into
   *  a code -> Unicode-codepoint map. Shared between Type0's 2-byte CIDs and
   *  a simple font's 1-byte codes — the CMap text format is identical either
   *  way; only how the caller SLICES its hex string differs (see decodeRun). */
  async function parseToUnicodeCMap(cmapObjNum: number): Promise<Map<number, number>> {
    const cmapBytes = await decompressedStream(cmapObjNum);
    const cmapText = cmapBytes ? new TextDecoder('latin1').decode(cmapBytes) : '';
    const map = new Map<number, number>();
    for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1], 16), parseInt(pair[2].slice(0, 4), 16));
      }
    }
    for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(triple[1], 16), hi = parseInt(triple[2], 16), base = parseInt(triple[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base + (c - lo));
      }
    }
    return map;
  }

  async function fontDecoderFor(fontObjNum: number): Promise<FontDecoder> {
    const obj = getObject(fontObjNum);
    if (!obj) return { kind: 'winansi' };
    if (/\/Subtype\s*\/Type0\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (!tuMatch) {
        warnings.push(`Type0 font object ${fontObjNum} has no /ToUnicode; its text will show as U+FFFD`);
        return { kind: 'cid', map: new Map() };
      }
      const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
      return { kind: 'cid', map };
    }
    // Simple font. Every KRS sample used /WinAnsiEncoding, which decodes
    // directly as windows-1252 bytes below — unchanged. North Dakota's
    // Century Code PDFs (fleet #2743) use simple TrueType fonts that declare
    // NO /Encoding at all: their embedded subsets number glyphs 0, 1, 2... in
    // whatever order the subsetter emitted them, with no relationship to any
    // standard code page — reading code 0x01 as the WinAnsi byte 0x01 (a
    // control character) produces blank/garbled output, not a wrong letter.
    // Those fonts DO carry a /ToUnicode CMap (the same mechanism Type0 fonts
    // use above, just keyed by a 1-byte code instead of a 2-byte CID), which
    // is the only place the real character is recorded — use it whenever the
    // font isn't declared WinAnsi rather than guessing.
    if (!/\/Encoding\s*\/WinAnsiEncoding\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (tuMatch) {
        const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
        if (map.size) return { kind: 'mapped1', map };
      }
      warnings.push(`font object ${fontObjNum} has a non-WinAnsi simple encoding and no usable /ToUnicode; decoded as WinAnsi anyway`);
    }
    return { kind: 'winansi' };
  }

  const TOKEN_RE =
    /\/(\S+)\s+[\d.]+\s+Tf|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^()])*)\)\s*Tj|1\s+0\s+0\s+1\s+[\d.-]+\s+([\d.-]+)\s+Tm/g;
  const TJ_PIECE_RE = /\(((?:\\.|[^()])*)\)|<([0-9A-Fa-f\s]*)>/g;

  function decodeRun(dec: FontDecoder, literal: string | undefined, hex: string | undefined): string {
    if (literal !== undefined) return unescapePdfLiteral(literal);
    const cleaned = (hex ?? '').replace(/\s+/g, '');
    let out = '';
    if (dec.kind === 'mapped1') {
      // 1-byte code per glyph (a simple font's code space), unlike Type0's
      // 2-byte CIDs below — see fontDecoderFor.
      for (let i = 0; i + 2 <= cleaned.length; i += 2) {
        const code = parseInt(cleaned.slice(i, i + 2), 16);
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    for (let i = 0; i + 4 <= cleaned.length; i += 4) {
      const cid = parseInt(cleaned.slice(i, i + 4), 16);
      if (dec.kind === 'cid') out += String.fromCodePoint(dec.map.get(cid) ?? 0xfffd);
      else out += String.fromCharCode(cid & 0xff);
    }
    return out;
  }

  const pageTexts: string[] = [];
  for (const pn of leafPages) {
    const page = getObject(pn);
    if (!page) continue;

    let resourcesDict = page.dict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
    if (resRef) {
      const ro = getObject(parseInt(resRef[1], 10));
      if (ro) resourcesDict = ro.dict;
    }
    // /Font is usually inline in Resources, but North Dakota's Century Code
    // PDFs (fleet #2743) write it as an indirect reference ("/Font 18 0 R")
    // to a separate dict object — resolve that one hop before giving up.
    let fontDictBody: string | null = null;
    const inlineFontMatch = /\/Font\s*<<([^>]*)>>/.exec(resourcesDict);
    if (inlineFontMatch) {
      fontDictBody = inlineFontMatch[1];
    } else {
      const fontRefMatch = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);
      if (fontRefMatch) {
        const fontObj = getObject(parseInt(fontRefMatch[1], 10));
        if (fontObj) fontDictBody = fontObj.dict;
      }
    }
    const fontMap = new Map<string, FontDecoder>();
    if (fontDictBody) {
      for (const fm of fontDictBody.matchAll(/\/(\S+?)\s+(\d+)\s+0\s+R/g)) {
        fontMap.set(fm[1], await fontDecoderFor(parseInt(fm[2], 10)));
      }
    }

    const contentsMatch = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(page.dict);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10))
      : [];
    let raw = '';
    for (const cr of contentRefs) {
      const dec = await decompressedStream(cr);
      if (dec) raw += new TextDecoder('latin1').decode(dec) + '\n';
    }

    let out = '';
    let currentFont: string | null = null;
    let lastY: number | null = null;
    for (const m of raw.matchAll(TOKEN_RE)) {
      if (m[1] !== undefined) { currentFont = m[1]; continue; }
      if (m[5] !== undefined) {
        const y = parseFloat(m[5]);
        if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
        lastY = y;
        continue;
      }
      const dec = (currentFont && fontMap.get(currentFont)) || { kind: 'winansi' as const };
      if (m[2] !== undefined) {
        for (const piece of m[2].matchAll(TJ_PIECE_RE)) out += decodeRun(dec, piece[1], piece[2]);
      } else if (m[3] !== undefined) {
        out += decodeRun(dec, undefined, m[3]);
      } else if (m[4] !== undefined) {
        out += decodeRun(dec, m[4], undefined);
      }
    }
    pageTexts.push(out.trim());
  }

  return { text: pageTexts.join('\n\n'), pages: leafPages.length, warnings };
}
/**
 * HHS-OIG Corporate Integrity Agreements — does this healthcare company have
 * a CIA, since when, what obligations, and what status? Fleet #2789.
 *
 * A Corporate Integrity Agreement (CIA) is a DIFFERENT condition from an
 * exclusion (mcps/leie, mcps/ny-omig-exclusions): an excluded provider is
 * barred from billing Federal health care programs; an entity under a CIA is
 * STILL PARTICIPATING, in exchange for binding compliance obligations OIG
 * negotiated instead of seeking exclusion. This pack sits beside those, not
 * on top of them — screening a provider against all three answers three
 * different questions.
 *
 * SOURCE AND SHAPE. OIG publishes the CIA roster only as a paginated,
 * filterable HTML listing
 * (oig.hhs.gov/compliance/corporate-integrity-agreements/browse-cias/) — no
 * JSON/REST endpoint, no bulk CSV/Excel export. 339 agreements as captured,
 * across 17 pages of 20. Root CLAUDE.md's standing rule 3 (this task) is
 * explicit: a baked table never sits in gateway module scope — so ONLY the
 * list (entity name, detail-page path, the status badge + date shown on the
 * card, location, report type) is baked, by
 * mcps/oig-corporate-integrity/scripts/bake-index.mjs, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy
 * (scripts/sync-gateway-static-json.mjs) and injected here as
 * `args._bakedIndex` — the same pattern as mcps/south-dakota-code,
 * mcps/ny-omig-exclusions and mcps/usgs-mineral-commodities (fleet #2754).
 *
 * WHAT IS **NOT** BAKED, ON PURPOSE. A matched entity's effective date,
 * term/duration, settlement amount, and the agreement PDF's own URL and text
 * are fetched LIVE, per call, from that entity's own detail page and PDF —
 * never pre-crawled for all 339 rows. That is both cheaper (most callers
 * never ask about most of the 339) and fresher: a newly-closed or
 * newly-suspended agreement is visible the moment OIG posts it, rather than
 * waiting for the next bake. See bake-index.mjs's header for the full
 * reasoning.
 *
 * ENTITY MATCHING, same shape as mcps/ny-omig-exclusions and mcps/leie: an
 * exact (case-insensitive) name match is the strongest signal this list can
 * give; a normalized-name or token match is a CANDIDATE lead, labelled as
 * such, never silently upgraded to an exact answer. CIA entity names are
 * frequently COMPOUND — a company plus one or more individually-named
 * co-signers ("SNAP Diagnostics, LLC and Gil Raviv") — so a caller searching
 * just "SNAP Diagnostics" needs the normalized/substring path to find it;
 * see `matchCandidates` below.
 *
 * TRANSPORT/PARSE FAILURES THROW LOUD, NEVER found:false (root CLAUDE.md
 * standing rule 2; see src/index.test.ts). A non-200 from the detail page or
 * PDF, or a 200 whose HTML/PDF no longer matches the shape this pack parses,
 * is reported as a thrown error naming the upstream status — a silent
 * found:false there would be indistinguishable from "no CIA on file", which
 * for a compliance screening tool is exactly the failure that matters most.
 *
 * This is an official HHS-OIG public enforcement record, published
 * specifically so providers, payers, counsel and the public can look up
 * whether an entity is under a CIA. Baking a copy of the LIST needs no reuse
 * grant on that footing alone; the per-entity detail and PDF text are
 * fetched live rather than mirrored, which is the stronger footing still
 * (root pipeworx CLAUDE.md, "PROXYING is not REDISTRIBUTING").
 *
 * Keyless, no signup.
 */
import type { OigCiaRow } from './oig-cia-index-data.js';

const UA = 'pipeworx-mcp-oig-corporate-integrity/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'HHS Office of Inspector General — Corporate Integrity Agreements';
const SITE = 'https://oig.hhs.gov';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

// fleet #2754 / root CLAUDE.md rule 3 — the baked LIST (339 rows, ~105KB) is
// injected by the gateway as `args._bakedIndex`, loaded from KV once per
// isolate. NEVER value-import ./oig-cia-index-data.js here — only the
// type-only import above, which is erased at compile time. A value import
// puts the whole table back in the bundle and into every isolate's heap;
// scripts/check-gateway-bundle-size.mjs fails the deploy if that happens.
let ROWS: OigCiaRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.OIG_CIA_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no CIA found" from
    // an empty table would be a silent wrong answer, indistinguishable from
    // a real clean screening result.
    throw new Error(
      `oig-corporate-integrity: the baked CIA list is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as OigCiaRow[];
  DATA_AS_OF = String(idx?.OIG_CIA_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.OIG_CIA_SOURCE_URL ?? `${SITE}/compliance/corporate-integrity-agreements/browse-cias/`);
  CAPTURED_AT = String(idx?.OIG_CIA_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.OIG_CIA_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'HHS Office of Inspector General — Corporate Integrity Agreements';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

type MatchType = 'exact_name' | 'normalized_exact' | 'normalized_candidate' | 'token_candidate';

const MATCH_MEANING: Record<MatchType, string> = {
  exact_name: 'The entity name matched exactly.',
  normalized_exact: 'The name matched exactly once case, punctuation and spacing differences are ignored.',
  normalized_candidate:
    'The query is a substring of this entity\'s full name (CIA entity names are often compound — a company plus named co-signers). Treat as a lead to confirm, not a confirmed identification.',
  token_candidate:
    'Every word in the query appears somewhere in this entity\'s name, but not as a contiguous match. Treat as a weaker lead — confirm by reading the full entity name.',
};

interface Candidate {
  name: string;
  status: string;
  status_date: string | null;
  location: string | null;
  report_type: string | null;
  detail_url: string;
  match_type: MatchType;
  what_that_means: string;
}

function matchCandidates(query: string, limit: number): Candidate[] {
  const qNorm = normalize(query);
  const qTokens = qNorm.split(' ').filter(Boolean);
  const exact: Candidate[] = [];
  const normExact: Candidate[] = [];
  const substr: Candidate[] = [];
  const token: Candidate[] = [];

  for (const r of ROWS) {
    const nNorm = normalize(r.name);
    const detail_url = `${SITE}${r.detail_path}`;
    const base = { name: r.name, status: r.status, status_date: r.status_date, location: r.location, report_type: r.report_type, detail_url };
    if (r.name.trim().toLowerCase() === query.trim().toLowerCase()) {
      exact.push({ ...base, match_type: 'exact_name', what_that_means: MATCH_MEANING.exact_name });
    } else if (nNorm === qNorm) {
      normExact.push({ ...base, match_type: 'normalized_exact', what_that_means: MATCH_MEANING.normalized_exact });
    } else if (qNorm.length > 0 && nNorm.includes(qNorm)) {
      substr.push({ ...base, match_type: 'normalized_candidate', what_that_means: MATCH_MEANING.normalized_candidate });
    } else if (qTokens.length > 0 && qTokens.every((t) => nNorm.includes(t))) {
      token.push({ ...base, match_type: 'token_candidate', what_that_means: MATCH_MEANING.token_candidate });
    }
  }
  return [...exact, ...normExact, ...substr, ...token].slice(0, limit);
}

/** Decode the handful of HTML entities this site's own markup actually uses. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–');
}

interface DetailDoc {
  title: string;
  url: string;
  size: string;
}

interface DetailInfo {
  title: string;
  status_badge: string | null;
  effective_date: string | null;
  status_event: string | null;
  status_event_date: string | null;
  duration: string | null;
  location: string | null;
  settlement_amount: string | null;
  category: string[];
  tags: string[];
  documents: DetailDoc[];
}

/** Pull the labelled list of `usa-tag` spans following a given `<dt>` term — Report Type / Category / Tags. */
function extractTagGroup(html: string, label: string): string[] {
  const dtIdx = html.indexOf(`pep-metadata__term">${label}</dt>`);
  if (dtIdx === -1) return [];
  const nextDt = html.indexOf('pep-metadata__term', dtIdx + label.length);
  const window = html.slice(dtIdx, nextDt === -1 ? dtIdx + 2000 : nextDt);
  return [...window.matchAll(/usa-tag[^"]*">([^<]+)<\/span>/g)].map((m) => decodeEntities(m[1].trim()));
}

/** Parse a CIA detail page into the fields not available from the baked list. */
function parseDetailPage(html: string, fallbackName: string): DetailInfo {
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const title = h1Match ? decodeEntities(h1Match[1].replace(/\s+/g, ' ').trim()) : fallbackName;

  // There are (at least) two `pep-metadata__description` spans up here: the
  // first is the bare status badge ("Suspended" / "Closed" / "Active" / ...,
  // no <time> inside); the second carries the date info, in one of three
  // shapes: "Effective on <time> • Suspended <time>", "Effective from
  // <time> to <time>", or "Refused on <time>" (one date only). Find them by
  // CONTENT, not position — the span with a bare word and no `<time>` is the
  // badge, the first one that DOES contain `<time>` is the date span.
  const descSpans = [...html.matchAll(/<span class="pep-metadata__description">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  const status_badge = descSpans.length > 0 ? descSpans[0]!.replace(/\s+/g, ' ').trim() : null;
  const dateSpan = descSpans.find((s) => /<time\b/.test(s)) ?? null;

  let effective_date: string | null = null;
  let status_event: string | null = null;
  let status_event_date: string | null = null;
  if (dateSpan) {
    // Each keyword is followed either directly by its <time> (the second
    // date after a bullet, e.g. "• Suspended <time>", or "to <time>") or by
    // a connector word first ("Effective on <time>", "Effective from
    // <time>", "Refused on <time>") — the connector is optional so both
    // shapes match the same pattern.
    for (const m of dateSpan.matchAll(/(Effective|Suspended|Closed|Refused|to)\s*(?:on|from)?\s*<time datetime="([\d-]+)"/g)) {
      const [, keyword, iso] = m;
      if (keyword === 'Effective') effective_date = iso;
      else if (keyword === 'to') {
        status_event = status_event ?? 'Closed';
        status_event_date = iso;
      } else {
        status_event = keyword;
        status_event_date = iso;
      }
    }
  }

  const durationMatch = /Duration\s+([^<]+?)\s*<\/span>/.exec(html);
  const duration = durationMatch ? durationMatch[1].trim() : null;

  const locationMatch = /Location<\/dt>\s*<dd[^>]*>\s*([^<]+?)\s*<\/dd>/.exec(html);
  const location = locationMatch ? decodeEntities(locationMatch[1].trim()) : null;

  const settlementMatch = /Settlement Amount<\/dt>\s*<dd[^>]*>\s*([^<]+?)\s*<\/dd>/.exec(html);
  const settlement_amount = settlementMatch ? settlementMatch[1].trim() : null;

  const documents: DetailDoc[] = [...html.matchAll(/<a href="([^"]+\.pdf)">\s*<span class="text-bold">([^<]+)<\/span>\s*\(PDF,\s*([^)]+)\)/g)].map(
    (m) => ({ url: `${SITE}${m[1]}`, title: decodeEntities(m[2].trim()), size: m[3].trim() }),
  );

  const category = extractTagGroup(html, 'Category');
  const tags = extractTagGroup(html, 'Tags');

  return { title, status_badge, effective_date, status_event, status_event_date, duration, location, settlement_amount, category, tags, documents };
}

async function fetchDetail(detailPath: string, fallbackName: string): Promise<DetailInfo> {
  const url = `${SITE}${detailPath}`;
  const res = await pwFetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const html = await res.text();
  if (html.length < 500 || !/pep-metadata__description/.test(html)) {
    // A 200 that is not actually the detail page we expect (bot wall,
    // maintenance interstitial, redesign) — throw loud rather than parse
    // garbage into a believable-looking wrong answer.
    throw new Error(
      `oig-corporate-integrity: detail page at ${url} returned HTTP 200 but its content does not match the expected CIA detail page shape (upstream may be degraded or the page layout changed).`,
    );
  }
  return parseDetailPage(html, fallbackName);
}

async function checkCia(args: Record<string, unknown>) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name — the entity (company and/or individual) to check for a Corporate Integrity Agreement.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  const limit = Math.max(1, Math.min(20, Math.floor(typeof args.limit === 'number' ? args.limit : 5)));
  const candidates = matchCandidates(name, limit);

  if (candidates.length === 0) {
    return {
      found: false,
      query: name,
      result: 'No Corporate Integrity Agreement found for that entity on the current HHS-OIG CIA list.',
      total_agreements_on_list: TOTAL_ROWS,
      caveat:
        'This checks the current HHS-OIG Corporate Integrity Agreement roster only. It does not cover the federal LEIE exclusion list (mcps/leie), any state Medicaid exclusion list, or CIAs that predate this list and have since been fully closed and removed from the published roster.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  // Enrich only the best (first) candidate with a live detail-page fetch —
  // effective date, term, settlement amount and the agreement document URL
  // are not in the baked list (see this file's header for why).
  const best = candidates[0]!;
  const detail = await fetchDetail(best.detail_url.replace(SITE, ''), best.name);

  const enriched = {
    ...best,
    effective_date: detail.effective_date,
    term: detail.duration,
    status_detail_badge: detail.status_badge,
    status_event: detail.status_event,
    status_event_date: detail.status_event_date,
    settlement_amount: detail.settlement_amount,
    category: detail.category,
    tags: detail.tags,
    agreement_documents: detail.documents,
    agreement_url: detail.documents[0]?.url ?? null,
    enriched: true,
  };

  return {
    found: true,
    query: name,
    best_match: enriched,
    other_candidates: candidates.slice(1),
    count: candidates.length,
    not_an_identification:
      best.match_type === 'exact_name' || best.match_type === 'normalized_exact'
        ? undefined
        : 'This is a NAME CANDIDATE, not a confirmed identification — confirm against the full entity name and location before relying on it.',
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
  };
}

// ---- Obligation extraction (oig_cia_obligations) ----

interface ObligationCategory {
  key: string;
  label: string;
  terms: string[];
}

const OBLIGATION_CATEGORIES: ObligationCategory[] = [
  { key: 'board_resolution', label: 'Board Resolution', terms: ['Board Resolution'] },
  { key: 'iro_review', label: 'Independent Review Organization (IRO) reviews', terms: ['Independent Review Organization', 'IRO'] },
  { key: 'compliance_officer', label: 'Compliance Officer / Compliance Committee', terms: ['Compliance Officer', 'Compliance Committee'] },
  { key: 'reporting', label: 'Reporting obligations (Annual/Implementation Reports)', terms: ['Implementation Report', 'Annual Report', 'Reporting Period'] },
  { key: 'disclosure_program', label: 'Disclosure program', terms: ['Disclosure Program'] },
  { key: 'exclusion_screening', label: 'Excluded-persons screening', terms: ['Excluded Person', 'exclusion screening'] },
];

function findExcerpt(text: string, term: string, radius = 180): string | null {
  const idx = text.indexOf(term);
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

async function obligations(args: Record<string, unknown>) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const documentUrl = typeof args.document_url === 'string' ? args.document_url.trim() : '';

  if (!name && !documentUrl) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (resolved via oig_cia_check first) and/or document_url (the agreement_url from oig_cia_check\'s response).',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  let pdfUrl = documentUrl;
  let resolvedName = name || documentUrl;
  let detailUrl: string | null = null;

  if (!pdfUrl && name) {
    const candidates = matchCandidates(name, 1);
    if (candidates.length === 0) {
      return {
        found: false,
        query: name,
        result: 'No Corporate Integrity Agreement found for that entity on the current HHS-OIG CIA list.',
        total_agreements_on_list: TOTAL_ROWS,
        source: SOURCE_LABEL,
        source_url: SOURCE_URL,
        data_as_of: DATA_AS_OF,
      };
    }
    const best = candidates[0]!;
    resolvedName = best.name;
    detailUrl = best.detail_url;
    const detail = await fetchDetail(best.detail_url.replace(SITE, ''), best.name);
    if (!detail.documents.length) {
      return {
        found: false,
        query: name,
        matched_entity: best.name,
        status: best.status,
        result: 'OIG has not posted an agreement document for this entity on its detail page (seen for some older, fully closed agreements).',
        detail_url: best.detail_url,
        source: SOURCE_LABEL,
        source_url: SOURCE_URL,
        data_as_of: DATA_AS_OF,
      };
    }
    pdfUrl = detail.documents[0]!.url;
  }

  const pdfRes = await pwFetch(pdfUrl, { headers: { Accept: 'application/pdf' } });
  if (!pdfRes.ok) throw await httpError(pdfRes, UPSTREAM);
  const contentType = pdfRes.headers.get('content-type') ?? '';
  const buf = await pdfRes.arrayBuffer();
  if (!contentType.includes('pdf') && buf.byteLength < 1000) {
    throw new Error(`oig-corporate-integrity: expected a PDF at ${pdfUrl} but got content-type "${contentType}" and ${buf.byteLength} bytes — the upstream may be degraded.`);
  }
  const extracted = await extractPdfText(buf);
  if (!extracted.text || extracted.pages === 0) {
    throw new Error(
      `oig-corporate-integrity: could not extract text from the agreement PDF at ${pdfUrl} (pages found: ${extracted.pages}, warnings: ${extracted.warnings.join('; ') || 'none'}). This is a parse failure, not an absence of obligations.`,
    );
  }

  const found_categories = OBLIGATION_CATEGORIES.map((cat) => {
    for (const term of cat.terms) {
      const excerpt = findExcerpt(extracted.text, term);
      if (excerpt) return { key: cat.key, label: cat.label, found: true, matched_term: term, excerpt };
    }
    return { key: cat.key, label: cat.label, found: false, matched_term: null, excerpt: null };
  });

  return {
    found: true,
    entity: resolvedName,
    detail_url: detailUrl,
    document_url: pdfUrl,
    pages_extracted: extracted.pages,
    obligations: found_categories,
    note: 'Each category reports whether that term appears in the agreement text, with a short excerpt — not every CIA includes every category (e.g. a sole-individual CIA typically has no Board Resolution requirement). Read the full agreement at document_url for the binding text; this is a navigation aid, not a substitute for it.',
    extraction_warnings: extracted.warnings,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

// ---- Browse (oig_cia_list) ----

async function listAgreements(args: Record<string, unknown>) {
  const status = typeof args.status === 'string' ? args.status.trim() : '';
  const limit = Math.max(1, Math.min(100, Math.floor(typeof args.limit === 'number' ? args.limit : 25)));
  const offset = Math.max(0, Math.floor(typeof args.offset === 'number' ? args.offset : 0));

  let rows = ROWS;
  if (status) {
    const sNorm = status.toLowerCase();
    rows = rows.filter((r) => r.status.toLowerCase() === sNorm);
  }

  const page = rows.slice(offset, offset + limit).map((r) => ({
    name: r.name,
    status: r.status,
    status_date: r.status_date,
    location: r.location,
    report_type: r.report_type,
    detail_url: `${SITE}${r.detail_path}`,
  }));

  return {
    found: page.length > 0,
    count: page.length,
    total_matching: rows.length,
    total_agreements_on_list: TOTAL_ROWS,
    offset,
    limit,
    agreements: page,
    status_filter_applied: status || null,
    valid_status_values: ['Effective', 'Suspended', 'Closed', 'Refused'],
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'oig_cia_check',
    description:
      'Does this healthcare company or individual have an HHS-OIG Corporate Integrity Agreement (CIA)? Checks a name against the current HHS-OIG CIA roster — companies and individuals OIG agreed not to exclude from Medicare/Medicaid in exchange for binding compliance obligations, as part of a False Claims Act or other settlement. Different from an EXCLUSION (see the leie / ny-omig-exclusions packs): a CIA entity is still participating, under obligations. '
      + 'An exact name match is the strongest signal; a normalized-name or partial/token match is returned as a labelled CANDIDATE, since CIA entity names are often compound (a company plus named co-signers) — e.g. searching "SNAP Diagnostics" finds "SNAP Diagnostics, LLC and Gil Raviv" as a candidate. '
      + 'Returns, for the best match: status (Effective/Suspended/Closed/Refused), effective date, term/duration, settlement amount, and the agreement PDF URL (fetched live from the entity\'s own detail page — not stale). Returns found:false with the list\'s as-of date and total agreement count when no match exists. Sourced from HHS-OIG, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Company or individual name to check, e.g. "SNAP Diagnostics" or "Alliance Parent, Inc.". Any word order; partial names are matched as candidates.' },
        limit: { type: 'number', description: 'Maximum candidates to return (default 5, max 20). Only the top/best candidate is enriched with live detail-page data.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'oig_cia_obligations',
    description:
      'What obligations does this entity\'s Corporate Integrity Agreement actually impose — Board Resolution, Independent Review Organization (IRO) reviews, Compliance Officer/Committee, Annual/Implementation reporting, a disclosure program, excluded-persons screening? Resolves the entity (same matching as oig_cia_check) or takes a direct document_url (from oig_cia_check\'s agreement_url field), fetches the agreement PDF LIVE from oig.hhs.gov, extracts its text, and reports which of those obligation categories appear in the text with a short excerpt for each. Not every CIA includes every category — a sole-individual CIA typically has no Board Resolution clause, and some older closed agreements have no PDF posted at all (reported as found:false, not an error). Sourced from HHS-OIG, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Company or individual name to look up (resolved the same way as oig_cia_check). Omit if passing document_url directly.' },
        document_url: { type: 'string', description: 'A specific agreement PDF URL under oig.hhs.gov/documents/cias/..., e.g. from a prior oig_cia_check call\'s agreement_url field. Overrides name-based lookup when given.' },
      },
    },
  },
  {
    name: 'oig_cia_list',
    description:
      'Browse the current HHS-OIG Corporate Integrity Agreement roster by status — e.g. list every currently Suspended or Refused-by-Entity agreement. Reads the baked CIA list (refreshed periodically; data_as_of says when) rather than live detail pages, so it is fast but does not include effective dates/terms/documents — call oig_cia_check for those on a specific entity. Sourced from HHS-OIG, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter to one status: Effective, Suspended, Closed, or Refused. Omit to list all.' },
        limit: { type: 'number', description: 'Max rows to return (default 25, max 100).' },
        offset: { type: 'number', description: 'Rows to skip, for paging (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'oig_cia_check':
      return checkCia(args);
    case 'oig_cia_obligations':
      return obligations(args);
    case 'oig_cia_list':
      return listAgreements(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
