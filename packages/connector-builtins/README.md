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
application configuration or authorization implementation. Existing descriptor
example strings are documentation metadata for the application's Skill adapter;
execution does not require Notebook, Skills or `host.mcp`.

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
