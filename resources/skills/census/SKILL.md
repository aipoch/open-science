---
name: census
description: Search CELLxGENE Census datasets and query bounded single-cell observation metadata by organism, tissue, cell type or disease using Notebook Python. Use for dataset discovery and cohort inspection; expression matrices require a separate SDK analysis.
license: Apache-2.0
metadata:
  display-name: CELLxGENE Census
  third_party:
    - kind: service
      name: CELLxGENE Census
      info_url: https://chanzuckerberg.github.io/cellxgene-census/
---

# CELLxGENE Census

Run queries in the session's bound Notebook Python environment. Follow the existing
Environment & Packages workflow for missing dependencies. Install the native
TileDB-SOMA library from Conda, then the Census SDK from PyPI in the same bound
runtime:

```text
manage_packages(language="python", packages=["tiledbsoma-py"], channels=["conda-forge", "tiledb"])
manage_packages(language="python", packages=["cellxgene-census"], usePip=true)
```

Restart with `notebook_restart` when the install receipt requires it. Do not install
from Bash or select a separate system Python. The [upstream SDK supports Linux and
macOS](https://chanzuckerberg.github.io/cellxgene-census/cellxgene_census_docsite_installation.html);
use an existing supported execution environment rather than creating a separate
Census runtime.

The real Notebook sandbox path was validated on macOS 14 with
`cellxgene-census==1.18.0` and Conda `tiledbsoma-py==1.17.1`. On that system, PyPI
TileDB-SOMA 2.3.0 and 2.1.2 wheels failed to load with a missing C++ symbol; its
1.17.1 wheel loaded but failed native TLS inside the sandbox. Use the Conda build
through `manage_packages` if this occurs. Do not replace system libraries, disable
TLS checks, or bypass the sandbox.

## Notebook calls

Include `kernelSkillIds: ["census"]` on each `notebook_execute` request using these
helpers. The functions are loaded by Notebook; no source loading or import is needed.
Use the existing execution timeout option for bounded work, for example 180 seconds.

```json
{
  "kernelSkillIds": ["census"],
  "code": "datasets = census_list_datasets(query='liver', limit=10)\nprint(datasets)"
}
```

```json
{
  "kernelSkillIds": ["census"],
  "code": "cells = census_query_cells(tissue='liver', cell_type='hepatocyte', limit=10, census_version=datasets['census_version'])\nprint(cells)"
}
```

- `census_list_datasets(query='', limit=25, census_version='stable')` searches dataset
  IDs, titles, collection names and citations. Returns `census_version`, matching
  `total`, and `datasets`.
- `census_query_cells(organism='homo_sapiens', tissue=None, cell_type=None,
disease=None, limit=25, census_version='stable')` requires at least one nonblank
  tissue, cell-type or disease filter. Returns `census_version`, `organism`,
  `total_returned`, and `cells`.

Both return at most 100 records. Tissue matches `tissue_general`; filters use exact
values, not substring search or arbitrary query expressions. Composite disease
values are not expanded. Cells are not deduplicated across datasets and are the
first row-major matches, not a representative sample. `total_returned` is not the
cohort size. Missing response columns in older releases are omitted; filtering on
a missing column fails explicitly. Valid filters with no matching combination may
still scan until the Notebook timeout. Cancel through Notebook if necessary.

`stable` and `latest` change over time. Reuse the returned concrete release for
subsequent queries and include it in reports. The helper closes each SOMA handle
and retries only one S3 checksum-mismatch failure; it never disables checksum checks.

## Network and execution

Requests use the existing Notebook network sandbox and its authorization flow.
The helper passes that process's HTTP proxy and CA bundle into TileDB's native S3
configuration; without a custom CA bundle it uses the SDK's Requests/certifi trust
roots. TLS certificate and checksum verification remain enabled. Allow the Census directory host `census.cellxgene.cziscience.com` and
the Census public S3 endpoint when requested; do not persist grants automatically
or disable the sandbox. Never print proxy environment variables or credentials.

Bash may run an independent SDK script when explicitly needed, using the intended
Python environment and existing shell authorization. These registered helpers are
provided through Notebook; Bash does not inject `kernelSkillIds`.

This Skill has no `host.mcp` tools and does not manage its own interpreter or
background process. For expression matrices, use the SDK in Notebook with explicit
cohort bounds and an appropriate memory budget; the metadata helpers do not fetch X.

[Official Python API](https://chanzuckerberg.github.io/cellxgene-census/python-api.html)
