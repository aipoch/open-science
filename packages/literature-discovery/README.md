# @aipoch/literature-discovery

Reference resolution, metadata review/commit, full-text acquisition and resumable batch jobs.
The package owns provider parsing, identifiers, candidate/review lifetimes, retries, progress,
checkpoint versions and recovery decisions. It does not import application sources or Prisma.

- `.`: resolver, metadata enricher, full-text finder, batch jobs and capability types.
- `/contracts`: browser-safe discovery schemas and result-schema factories for a caller's reference view.
- `/jobs`: browser-safe batch commands, results and progress.
- `/download`: public-HTTPS download validation and an optional caller-supplied proxy tunnel.
- `/checkpoints`: batch journal construction with an explicit durable storage capability.

For proxied downloads, uniform IPv4 Fake-IP answers in `198.18.0.0/15` use the hostname
instead of a pinned IP. The configured proxy then owns DNS resolution and final-address
access restrictions; the downloader cannot verify that the proxy's destination is public.
TLS still verifies the publisher hostname. Mixed answers and direct Fake-IP connections
remain blocked. The host's SOCKS4 adapter requires numeric IPv4 destinations and does not
support this hostname fallback; use HTTP, HTTPS or SOCKS5 for remote resolution.

Provide catalog reads/atomic commits, atomic content publication, PDF inspection, credentials and
network transport. Batch jobs require durable checkpoint storage, write admission and oversized
result error translation. Checkpoint storage must atomically publish writes, preserve recovery
barriers and recover interrupted replacements; the package decides journal versions and epochs.
The journal uses the injected capability for durable reads/writes and recovery, but directly
uses `node:fs/promises` for directory creation, enumeration and cleanup (`mkdir`, `readdir`, `rm`).
The checkpoint capability is not a complete virtual filesystem.
Do not silently discard an unknown newer journal. Call `close()` before releasing host resources.

Reference snapshots validate the fields discovery reads and preserve caller-owned extension data.
Application transports can use the result-schema factories with stricter reference schemas.
No state/schema changes are required: batch indexes v1/v2/v3 remain readable and writes use v3.

Run `npm run build` and `npm test` inside this package. The repository's isolation check packs the
package, installs its declared sibling tarball and validates consumption outside the checkout.

## Single-paper citation discovery

`LiteratureRelatedFinder` resolves an existing catalog reference and pages its references or
citing papers. `provider` defaults to `europe-pmc`; the legacy `auto` value has the same behavior.
Callers may explicitly select `europe-pmc` or `opencitations`; each selection contacts only that
provider. Failures remain attributed to that source and never start another provider automatically.
Every live result reports its actual `provider`. Legacy provider values and temporary 40-character
paper IDs are rejected by the graph schemas.
Historical catalog provenance and other discovery features use their own contracts.

Europe PMC resolves an exact normalized DOI, PMID or PMCID. If these do not resolve, it can verify a unique saved Europe PMC source and external ID against the search result. It never guesses from a
title. Conflicting saved/provider identifiers and ambiguous matches are rejected; MED is preferred
when both MED and PMC index the same DOI. The host injects catalog reads and transport; the finder
never writes catalog records. UI selections use the existing Library candidate-review workflow.
Europe PMC focuses on biomedical literature; an empty result does not imply absence of citations,
especially for works outside that scope.

OpenCitations defaults to the official SKG-IF API (`opencitationsMode: 'skg-if'`). Root resolution verifies a single normalized DOI against the returned records. A saved paper without a DOI can also reopen through its unique OpenCitations OMID after direct product verification. DOI queries always
use lowercase keys: the service can return an empty response for mixed-case DOI filters. Several
OMIDs may represent the same DOI; a stable real OMID supplies the seed metadata while queries
retain the DOI to cover those aliases. Discovered centers with a unique DOI follow the same rule;
centers without a DOI use their observed OMID. Native IDs use `opencitations:br/digits`
and URLs use `https://w3id.org/oc/meta/br/digits`. The adapter preserves supplied author name
components, publication types, dates and supported identifiers; it omits records without a real
OMID or title and reports their number. No titles or missing authors are fabricated.

References use the union of `related_products.cites` from every exact DOI identity, or from the
validated single product for a center without a DOI. The complete adjacency is validated, sorted
and bound to that token and seed; later offsets reuse the same snapshot. Identity responses with
more than 20 aliases, incomplete alias pages or more than 2000 reference IDs are rejected rather
than truncated. Metadata for each page's 20 OMIDs is fetched through the same official host's
Meta batch endpoint. Meta may return several rows per requested ID: only complete exact OMID
tokens match, foreign rows never become edges, and each requested ID yields at most one record.
Missing metadata or titles count as omitted IDs. Meta's author labels remain literal names.

SKG-IF `cf.cites_doi`/`cf.cites` still page citing products. Citation offsets are multiples of 20,
mapped to one-based `page` and `page_size=20` queries. The adapter validates pagination against
the requested filter, page and fixed official origin, reconstructs every request, and never
dereferences JSON-LD contexts or response links. A 404 is accepted as empty only for a validated
JSON-LD search envelope; a failed Meta batch remains an error. Both paths share the existing
2 MiB response limit, single 30-second deadline, provider cooldown and token/root safeguards,
and require no API credentials.

Callers may explicitly select `opencitationsMode: 'index'` with `provider: 'opencitations'`
for the official Index v2 API and Meta identity/metadata endpoints. The UI labels the two modes
`OpenCitations · SKG-IF` and `OpenCitations · Index v2`; Index is an explicit mode, not an automatic fallback. This manual alternative never
starts automatically after SKG-IF fails. The mode remains fixed on the resolution token; omitting
the mode in later requests inherits it, while an explicit mismatch expires the request. Index
and SKG-IF coverage and counts can differ and are not interchangeable observations.
Index identity uses one verified DOI, or one saved real OMID when the saved record has zero or
multiple DOI aliases. Multiple saved DOIs must all be present in the same matching Meta row;
without that evidence or a unique saved OMID, resolution does not guess or combine metadata rows.
Each direction loads one complete response of at most 2000 edges before publishing a sorted,
immutable OMID snapshot, then hydrates 20 IDs per page through Meta. Each OCI must exactly match
its two uniquely supplied OMIDs, and any queried target DOI must appear among its normalized aliases.
Neighbor DOI aliases are retained to reject explicitly disjoint Index/Meta DOI claims while
allowing overlapping aliases and missing DOI metadata. Pagination and direction changes reuse
their respective snapshot; exploration starts fresh snapshots. Cancellation, a changed original
reference or failed validation cannot publish snapshots or new capabilities. The same fixed
origin, response bound, deadline, admission and retry rules apply to both modes.

An OpenCitations request can spend at most one retry across all its identity, metadata and page
reads. Only explicitly recognized transient transport errors or HTTP 502/503/504 qualify, and
a valid `Retry-After` hint suppresses immediate retry. The retry revalidates the saved root,
uses the same provider admission gate and original 30-second deadline, and grants capabilities
only after the completed page passes the final root check. Cancellation, authentication, 429,
unknown transport errors, malformed JSON, invalid metadata and response-size limits do not retry.
Response cleanup failures never replace an authoritative HTTP or parsing/size error.

Hosts may inject `onDiagnostic` to observe failed reads, successful retry recovery and validation
failures. Events contain only fixed provider/endpoint/phase categories, attempt/outcome, status,
an allowlisted transport code, safe issue codes, elapsed time and byte counts. They exclude URLs,
identifiers, tokens, headers, response content and raw error messages. Observer failures are isolated
from request behavior. A recovered read does not imply the root's final validation succeeded.

A resolution is published only after its first completed page and a root-identity recheck. Each token fixes one provider. Later pages,
direction changes and exploration failures return that provider's error without mixing sources.
An empty relationship page is a successful source observation, not proof that no citations exist.
Europe PMC relationship rows without a stable source/ID or title are counted in `omitted` and do
not become invented graph nodes. Native source IDs use `europe-pmc:SOURCE:ID` or
`opencitations:br/digits`. Available DOI/PMID/PMCID values remain in metadata
for review. Provider author names, including Europe's combined `authorString`, remain literal;
name components are not inferred from punctuation.

For temporary exploration, send `seedPaperId` with a `resolutionToken`, while retaining
the original saved `itemId` and `expectedMetadataRevision`. The selected paper must be the token's
seed or a record returned by one of its completed pages. Changing the seed requires offset zero
and returns a new token; use that token for subsequent directions and pages. Each request still
validates the original saved reference. Exploration never adds the selected paper to the catalog.
Each token retains at most 2000 recently returned records for further exploration; an evicted
record must be fetched again before becoming a seed. Expired tokens require a fresh root lookup.

Requests use fixed HTTPS origins, one-request-per-second admission per provider, responses bounded
to 2 MiB, and a single 30-second deadline. Caller cancellation and changed root references stop
the lookup. HTTP 429 respects a capped Retry-After cooldown. Up to 200 least-recently-used
resolution tokens remain in memory and expire after 24 hours. Each session caches its ten most
recent successful pages, keyed by direction and offset. Reopened views reuse the original root
session only when item ID, metadata revision, provider and source mode match. Cache hits still
validate the saved root and caller cancellation. Reads do not extend expiry; failures are not
cached. Cached pages remain available during source cooldowns. Sessions and pages are discarded
on process restart, with no disk persistence or migration. Identical concurrent requests share a lookup while retaining independent cancellation ownership;
the transport is canceled only when the final caller leaves. Retained sessions also have a 32 MiB
serialized-data budget (not a measurement of JavaScript heap overhead). Successful reads touch LRU
order. A fresh root request with `refresh: true` bypasses the cache; failure preserves previous
results and success replaces the default root lookup without revoking other views' tokens.
Uncached offset pages on live Europe PMC and SKG-IF citation endpoints require a new root lookup
after a 15-minute continuation window. Cached pages still last up to 24 hours; immutable Index and
SKG-IF reference snapshots retain their normal lifetime. Live APIs do not guarantee a transactional
snapshot even within this window. Results and records carry their actual `retrievedAt` time. Pages contain at most 20 raw rows;
Europe PMC offsets are multiples of 20 mapped to one-based `page` parameters. Its references and
citations response `request.offSet` fields use different bases, which are checked independently.

The application assigns each lookup an optional UUID `requestId`. Closing the panel or changing
its source cancels outstanding lookups through `literature:cancel-related`; cancellation is scoped
to the originating caller lease and generation. Older callers may omit the ID. A short-lived,
bounded cancellation record handles cancellation arriving before its lookup. These records, graph
positions, navigation history and resolution tokens are memory-only, so closing the view clears
its exploration path. Graph counts describe loaded records; positions do not encode similarity.

Explicitly adding papers still uses Inbox review. Repeated discoveries preserve the candidate's
original review snapshot and append source evidence. Citation sources store distinct paths in
`rawMetadata.citationContexts`, including the original item/revision, explored or seed paper,
direction and OpenCitations mode when available. Acceptance and item merges retain these paths. Appending paths to a frozen Inbox source
preserves its original snapshot timestamp, so a newer Library source still wins during acceptance.
Explicit saves retain `retrievedAt` in existing source JSON, separately from the legacy `savedAt`
source-record write time. Old records without acquisition times remain unknown. The panel reuses cached results and offers a retry when a lookup fails.
List directions retain their loaded pages, selections and scroll positions while the panel stays
open. Both views share identity merging and a five-page-per-direction display budget.
When scholarly identifiers connect records with conflicting claims, the graph keeps their native
identities visible and excludes those records from automatic staging. Opening a paper's details
reuses the bibliographic lookup. Explicit saves can fill missing fields from a verified result
already viewed in that session and record its lookup identifier in `rawMetadata.metadataLookup`.
Batch staging starts no additional metadata lookups. Partial failures remain
selected across both direction tabs for retry.
The source disclosure resolves available local root titles and falls back to their stored IDs.
Existing top-level provenance fields are read into this collection on the next source update;
there is no database migration or new review state. Previously overwritten paths cannot be
reconstructed. This collection is provenance, not a saved graph or timestamped event history.

Returned content is attributed to its actual source. Coverage is incomplete and changes over time;
a small live comparison of three biomedical papers is not a coverage or reliability guarantee.
See Europe's official [REST service documentation](https://europepmc.org/RestfulWebService).
OpenCitations' [SKG-IF documentation](https://api.opencitations.net/skg-if/v1) describes its
exact identifier filters and relationship pagination; the official [Index documentation](https://api.opencitations.net/index/v2)
and [Meta documentation](https://api.opencitations.net/meta/v1) describe the explicit alternative. Counts describe source relationships,
not complete real-world citations or DOI-deduplicated works.

### Live Electron acceptance

The opt-in `e2e/literature-citation-graph-live.spec.ts` uses the complete application,
real IPC and public citation APIs. It creates one DOI reference in an isolated temporary
catalog; it does not import personal settings or credentials. Build with `npm run build:e2e`,
then run from the repository root:

```bash
OPEN_SCIENCE_CITATION_LIVE=1 npx playwright test e2e/literature-citation-graph-live.spec.ts
```

`OPEN_SCIENCE_LITERATURE_PROXY` optionally configures a proxy in that isolated profile;
`OPEN_SCIENCE_CITATION_DOI` overrides the default public seed. Each source checks both
relationship directions, available next pages, a discovered center and return to the original
graph snapshot. Evidence records directions without a next page explicitly. SKG-IF and Index
are separate cases. HTTP 429 and interrupted responses remain failed live checks, not skipped
or successful coverage. Normal CI skips these network-dependent cases unless explicitly enabled.

## Manual publication checks

`LiteraturePublicationChecker` checks an existing reference's exact, unambiguous DOI.
`get` restores a saved result without making a network request; `check` explicitly queries
Crossref's fixed HTTPS `/works/{doi}` endpoint. The `updated-by` reverse edges identify
notices about that work. `update-to` points in the opposite direction and is not used.
See [Crossref's production API guidance](https://www.crossref.org/labs/retraction-watch/).

Results preserve each notice's DOI, raw type, source and available full date, including self
updates, unknown types and reinstatement notices. They are observations of source metadata,
not an inferred integrity verdict: an empty result does not prove that a work is unaffected.
Crossref/Retraction Watch coverage, especially for corrections, concerns and reinstatements,
is incomplete. The host must atomically recheck active item identity, metadata revision and
DOI when saving a snapshot. A failed check never replaces the previous successful snapshot.
Network responses are limited to 2 MiB and 100 notices, with a 15-second deadline and capped
429 cooldown. Checks do not modify bibliographic metadata or screening decisions.
