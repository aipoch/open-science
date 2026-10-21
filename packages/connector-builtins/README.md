# @aipoch/connector-builtins

Built-in scientific Connector implementations for Node.js 22+. Select explicit provider entries;
there is no aggregate registry or implicit registration. PubMed and OpenAlex use
the same descriptor contract as Cellosaurus.

```ts
import { createConnectorRegistry } from '@aipoch/connector-core'
import { PUBMED_TOOLS } from '@aipoch/connector-builtins/pubmed'
import { OPENALEX_LITERATURE_TOOLS } from '@aipoch/connector-builtins/literature-openalex'
import { CELLOSAURUS_TOOLS } from '@aipoch/connector-builtins/cellosaurus'

const registry = createConnectorRegistry([
  ...PUBMED_TOOLS,
  ...OPENALEX_LITERATURE_TOOLS,
  ...CELLOSAURUS_TOOLS
])
const tools = registry.getConnectorTools('pubmed')
// Select the method from the registry's published descriptors, then validate
// its arguments and call ParserEngine with resolved provider credentials.
```

Representative public entries (the full whitelist is in `package.json#exports`):

- `./pubmed`: `PUBMED_TOOLS`; NCBI configuration uses `ncbiEmail` and `ncbiApiKey`.
- `./literature-openalex`: `OPENALEX_LITERATURE_TOOLS`; uses `openAlexApiKey`.
  Existing `literature/openalex_*` tool routes are preserved.
- `./cellosaurus`: `CELLOSAURUS_TOOLS`; no credential configuration.
- `./ncbi`: `ncbiEtiquette`, shared NCBI URL parameter encoding.

Only the caller resolves credentials; this package has no credential storage,
application configuration or authorization implementation. Descriptors provide schema-valid
`exampleArgs` data; consumers render their own invocation syntax. Settings groups and
application Skill policy belong to the host catalog/document adapters.

Install the `@aipoch/connector-core` peer alongside this package. A shared core
instance preserves transport error identity (including Cellosaurus 404 fallback).
Both ESM and CommonJS use the same compiled implementation. Private source and
build subpaths are not exported.

Run `npm install` with the core peer available, then `npm run typecheck`,
`npm test`, and `npm run build`. Tests use fixed responses; no service key or live
network is required. `npm pack` builds the distributable. When testing unreleased
siblings outside this repository, install the core tarball as the peer.

All bundled scientific families ship here, including ENCORI, genome jobs, variants,
RNA, structures, chemistry and literature. Family entries preserve existing tool
routes; importing one entry does not register the others. `./catalog` contains only
public metadata and no live configuration or secret values.

`./encori` exposes `createEncoriTools(publishFile)`. The injected publisher must write
the supplied temporary path, check cancellation, then atomically publish without
replacing an existing destination, including durability barriers required by the
host. The package owns partial-download identity, range checks, gzip validation,
recovery and its rate limiter. Existing filenames and receipts are unchanged.

`./molecule-render` exposes pure structure calculation. Session/Run selection,
Artifact creation and Provenance remain the host's responsibility. Rendering loads
OpenChemLib lazily; the host adapter persists the returned molfile through its
existing writer.

`./molecule` advertises only `render_molecule`. Application preview/Artifact actions
are registered by the host.

The following public, read-only methods require no credentials:

| Entry                 | Source                                                            | Methods                                         |
| --------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `./genes`             | [HGNC](https://www.genenames.org/help/rest/)                      | `get_hgnc_gene`, `resolve_hgnc_alias`           |
| `./pubmed`            | [PubTator 3](https://www.ncbi.nlm.nih.gov/research/pubtator3/api) | `get_pubtator_annotations`, `search_pubtator`   |
| `./clinical-genomics` | [DGIdb](https://dgidb.org/api)                                    | `get_dgidb_gene_drugs`, `get_dgidb_drug_genes`  |
| `./rna`               | [RNAcentral](https://rnacentral.org/api)                          | `get_rnacentral_record`, `get_rnacentral_xrefs` |
| `./orphadata`         | [Orphadata](https://api.orphadata.com/openapi.json)               | `get_disease_genes`, `get_disease_phenotypes`   |

HGNC, PubTator and RNAcentral share per-source process-local request admission at 10, 3 and
20 requests/second respectively. These methods do not automatically retry HTTP failures; the
core still supplies HTTP status, Retry-After guidance, deadlines, cancellation and response-size
limits. Separate processes on the same IP must coordinate their aggregate traffic. DGIdb and
Orphadata use the core's bounded retry policy. Each new method caps responses at 2 MB.

Pagination is explicit: PubTator returns one publication-search page, RNAcentral one mapping
page, and DGIdb one matching gene/drug record per cursor page. DGIdb's nested interactions are
unpaginated upstream; oversized responses fail instead of silently dropping evidence. HGNC
exact lookups preserve ambiguous matches and withdrawn status. PubTator annotation retrieval
accepts at most ten published PMIDs and never submits original text. RNAcentral uses API v1,
which is distinct from a dataset release. Orphadata preserves dataset dates, validation and
CC BY 4.0 attribution. DGIdb preserves each source's version and reuse terms; aggregated
interactions are not clinical recommendations. Cite original publications and source databases.

The host honors catalog `defaultEnabled` metadata (absence means enabled). Orphadata alone
is opt-in for Main. Explicit enabled/disabled choices persist in settings, with disabled taking
precedence on conflicting input; historical opt-outs and existing Specialist scope rules remain
unchanged. Older hosts may discard the new affirmative-choice field when saving settings,
requiring Orphadata to be enabled again after re-upgrade. No dataset cache or migration is used.
