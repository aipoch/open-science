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

## Scientific-data API and file discovery

`./research-datasets`, `./molecular-data` and `./literature-europepmc` expose native
`ToolDescriptor` arrays using the same `ParserEngine` HTTP context as existing providers.
HGNC extensions remain in Genes; Cellosaurus RDF/SPARQL/STR/file methods and the openFDA
bulk manifest extend their existing host routes. Europe PMC has a separate direct-search
entry; existing PubMed/PMC full-text methods are unchanged. New entries are opt-in.

Research Datasets discovers official NHANES and fixed-version public PhysioNet demo files,
and supplies declared official access instructions for CHARLS/CHNS/SEER/MIMIC/eICU/GBD
and FAERS. An access-guidance result never verifies a person's permission. SEER research
exports and GBD result exports still use their official software/portal. CTD supplies a
maintained subset of official public report links, explicitly marked as not live-verified;
it does not implement an undocumented web-query API or bypass browser verification.

File catalogs contain official HTTPS URLs and available upstream metadata, not local
paths, completed transfers or verified checksums. This scope adds file discovery/download
links, not a new binary download/import service. Obtain files through supported official
acquisition routes and use the existing approved file/Notebook workflows for analysis.
Preserve source terms, citation headers, survey design and declared dataset versions.

These descriptors do not spawn a runtime, install dependencies, create a DuckDB database,
persist job states, register data directories or take ownership of research files. Results
stay in the existing caller/session workflow. Existing custom-connector data or any data
created while trialling the unmerged #3809 implementation is neither migrated nor deleted.
This is an additive API change with no application database migration or new storage format.

`scientific-data.test.ts` covers schemas, exact request construction, content negotiation,
pagination/truncation, ambiguous mappings, no-retry enrichment submission, upstream failures
and access boundaries using the actual engine with fixed HTTP responses. These tests run
in the ordinary portable suite without Python, accounts or opt-in environment variables.
After the normal package build, `node scripts/verify-scientific-data-live.mjs` performs
separate small, live public-service smoke checks. It does not test private/full datasets,
perform a bulk transfer or claim coverage of every upstream response variant. External
availability is not a deterministic CI dependency.

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
existing writer. Output uses V2000 unless the total atom or bond count exceeds 999,
in which case it uses V3000. Explicit hydrogens count toward these limits.

`./molecule` advertises only `render_molecule`. Application preview/Artifact actions
are registered by the host.

`./genes` includes [HGNC](https://www.genenames.org/help/rest/)
methods `get_hgnc_gene` and `resolve_hgnc_alias`.

`./pubmed` includes
[PubTator 3](https://www.ncbi.nlm.nih.gov/research/pubtator3/api) methods
`get_pubtator_annotations` and `search_pubtator`.

`./clinical-genomics` includes [DGIdb](https://dgidb.org/api)
methods `get_dgidb_gene_drugs` and `get_dgidb_drug_genes`.

`./rna` includes [RNAcentral](https://rnacentral.org/api)
methods `get_rnacentral_record` and `get_rnacentral_xrefs`.

`./orphadata` includes
[Orphadata](https://api.orphadata.com/openapi.json) methods `get_disease_genes` and
`get_disease_phenotypes`.

These methods are public and read-only and require no credentials.

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

### Optional identity, label, sample and pathway providers

The `rxnorm`, `dailymed`, `biosamples` and `wikipathways` catalog entries have
`defaultEnabled: false`. Each has its own enablement choice and generated Skill;
adding these providers does not expand the default-on Drug Regulatory, Omics Archives
or Genes Skills. Existing explicit opt-outs still win over explicit opt-ins.

- `./rxnorm`: `resolve_name` and `get_concept` use the public
  [RxNorm API](https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html). Name resolution
  defaults to exact matching among active concepts and retains ambiguity. Normalized
  matching is explicit and can ignore salts; results do not establish clinical
  equivalence. Requests are spaced by at least 100 ms within the process. No UMLS
  credential, proprietary vocabulary, interaction or dosing endpoint is added.
- `./dailymed`: `search_labels` and `get_label_history` use the
  [DailyMed v2 service](https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm).
  Both return one page (default 20, maximum 100) with `next_page`. Retain SPL SET IDs,
  publication dates and versions, including archived labels with a null title. Accept
  documented numeric strings and current numeric fields without rewriting the evidence.
  No label files are downloaded; inclusion does not establish FDA approval.
- `./biosamples`: `search_samples` and `get_sample` use the
  [BioSamples HAL API](https://www.ebi.ac.uk/biosamples/docs/references/api/overview).
  Searches return one cursor page (default 20, maximum 100), with `next_cursor` derived
  from the upstream next link. Keep the query and page size unchanged when continuing.
  Sample characteristics, ontology terms, provenance dates and external references are
  retained; linked data is not followed. Applied curations use the upstream default.
- `./wikipathways`: `search_pathways` and `get_pathway` use current
  [WikiPathways JSON snapshots](https://www.wikipathways.org/json/), not the retired
  web service. Search covers names/IDs and exact species, with local offset pagination
  over a fetched list (default 20, maximum 100). Detail returns only the requested
  metadata record. Preserve source revisions and already-abbreviated descriptions;
  snapshots can change between calls. Graphs, full text, gene mappings and historical
  revisions are outside this initial scope.

All eight methods are read-only, credential-free and limited to 2,000,000 response
bytes per request. They do not create application data tables, migration state,
background jobs or persistent caches. Enablement uses existing host settings.

`./structures-pdb` adds `pdb_search_structure_similarity` to the existing Structures
family. [RCSB structure search](https://search.rcsb.org/) accepts a deposited four-character PDB ID
and `label_asym_id` (not the author chain ID), returning at most 50 experimental
chain hits with upstream ranking scores and total/truncation counts. This is a
structure-informed embedding search with global matching, a predicted TM-score
cutoff of 0.8 and 10,000 candidates, not a returned alignment or RMSD calculation.
Hit counts reflect these limits and are not an exhaustive inventory of all PDB chains;
the query chain can appear among the hits. Invalid or unsupported chains remain errors.
This tool uses the existing family switch, shared request deadline, cancellation
and response-size budget; it requires no credentials and adds no persistence.

### eQTL Catalogue file access

`./human-genetics` retains `eqtl_list_datasets` and `eqtl_associations`, replacing the
retired REST API with the official release-7 TSV file catalogue and HTTPS Tabix reads.
The manifest is pinned to a Git revision; response `reference_data` records that revision,
GRCh38, file/index URLs and whether the file contains full nominal (`.all`) or filtered
(`.cc`) statistics. Upstream file URLs themselves are not immutable release snapshots.

Dataset listing applies exact metadata filters locally and reports the actual matched total.
Association calls require explicit `genome_build: 'GRCh38'`, with no default. Missing builds,
GRCh37 and other values fail before network access. For a GRCh37 variant, first call the existing
Variants `liftover_variant` tool with `source_build: 'GRCh37'`; proceed only with a unique GRCh38
mapping, retaining the original variant and mapping provenance. That lookup table does not map
every variant. No automatic conversion or region liftover is performed, and converting only a
region's endpoints does not establish a complete corresponding region.
Association queries use 1-based inclusive GRCh38 regions (up to 5 Mb), exact gene/rsID/variant
filters and a local significance threshold. Explicit `pos`/`variant` queries need no coordinate
service. Calls containing only `gene_id`/`rsid` now fail with an actionable coordinate
requirement. Those identifiers remain exact filters when `pos` or `variant` is supplied.
The connector does not silently infer historical cis windows from current Ensembl annotations:
even a one-base TSS shift can omit a boundary observation. Resolve annotation-appropriate
coordinates explicitly through the existing genome tools. Results retain ALT as the effect
allele, missing values as null, original `pvalue_text` and derived `nlog10p` (including nonzero decimal p-values
that underflow JavaScript numbers). An upstream literal zero has unknown `nlog10p` and does not
pass a significance threshold.

A native read-only TBI/BGZF reader requires no installed Tabix executable, Python package or
new runtime dependency. It shares process-local admission of at most one file request every
two seconds, requires strong ETags across data ranges, validates exact HTTP ranges, and caps
compressed and inflated reads. It accepts only the official 1-based point-coordinate TBI layout;
unsupported interval layouts fail explicitly. It searches all covering TBI levels, including
parent-packed chunks, without assuming a particular writer's leaf-bin representation. Header
coordinate columns must agree with the indexed layout and malformed UTF-8 fails explicitly.
Linear-index pruning is omitted as a conservative implementation choice, not as a claim that
it can never improve performance.
Malformed metadata, HTTP failures, corrupt indexes/blocks, changed files and exceeded budgets
fail explicitly rather than returning a plausible empty result. A query collects one extra
matching record to prove truncation; an exact-cap exhausted result is complete. Published
files cover only tested cis windows and `.cc` files omit some molecular traits: no returned
rows is not evidence of no biological association. File queries create no files, persistent
cache, application tables or background jobs. Large/bulk analyses should use the official
local-file/Tabix workflow described at https://www.ebi.ac.uk/eqtl/Data_access/.

The protocol tests compare 47 base queries and 18 writer-packing queries across all six TBI
levels against a full-TSV-scan oracle. They cover chromosomes, bin boundaries, overlapping
chunks and nonzero BGZF offsets. Changing unused linear metadata is an invariance regression,
not a mechanism ablation or proof of no performance benefit. The opt-in command
`node scripts/eqtl-ablation.mjs /tmp/eqtl-ablation-report.json` copies sources/tests to disposable
temporary directories and removes one retained mechanism at a time. It records source hashes,
a passing baseline, a comment-only negative control, and the specific failed behavioral
assertions for each ablation. Compilation/runner failures, changed test inventories and
blanket hook failures do not count as detected mechanisms. It never
edits production files, adds runtime switches, calls external services or runs the full suite.
These finite experiments do not prove correctness for every upstream file or replace live
service verification; index/data semantic agreement still relies on the official publisher.
