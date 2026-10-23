# Bundled medical and molecular data engine

The application ships this first-party engine and publishes 14 built-in Connector entries:
NHANES, CHARLS, CHNS, SEER, MIMIC, eICU, FAERS, GBD, Europe PMC, HGNC, ChEA3,
bioDBnet, Cellosaurus Data and CTD. No third-party npm package, custom-Connector JSON
or machine-specific script path is required. The existing quick HGNC, PubMed/PMC,
openFDA and Cellosaurus tools remain available; these entries add specialized discovery,
file acquisition, local import and query workflows.

## Runtime and activation

Enable the required entries in Settings > Connectors. They are opt-in and share one
engine implementation, with isolated data roots and a lazily started worker per source.
`provider_info` and `access_requirements` are native host tools and work before Python
has been initialized. They report required access, official links and configured presence
without returning credential values or claiming approval.

Data operations use the application's managed default Python runtime. Initialize it in
Settings > Runtimes and use the existing `manage_packages` workflow to add the packages
in `requirements.txt` to that runtime. Dependency installation retains its existing approval
policy; opening/enabling a Connector never installs packages. Administrators can select an
already prepared interpreter with the application launch variable
`OPEN_SCIENCE_MEDICAL_PYTHON` (absolute executable path, Python 3.11+).

The host forwards only source-specific launch environment variables:

| Source | Variables | Requirement |
| --- | --- | --- |
| MIMIC, eICU | `PHYSIONET_USERNAME`, `PHYSIONET_PASSWORD` | Personal credentialing, training and project agreement; public demos need none |
| CHARLS | `CHARLS_COOKIE` | Approved supported download URLs only |
| CHNS | `DATAVERSE_API_TOKEN` | Only files requiring authentication; community files need a separate approved agreement |
| GBD | `GBD_COOKIE` | Supported approved file hosts; create exports in the official results tool |
| FAERS | `OPENFDA_API_KEY` | Recommended for online queries; optional for public bulk/local files |

These variables currently come from the host launch environment, **not** a new built-in
credential editor. Native NCBI/OpenAlex credentials remain in their existing application
settings. Do not put secrets in tool arguments, shared configuration, URLs or chat.

## Storage, lifecycle and access boundaries

Each source stores downloads, incoming files, DuckDB tables, receipts, jobs and query CSVs
under `<data-root>/medical-data/<provider>`. The directory participates in normal data-root
relocation. Stop the application before manual migration/removal. Removing a Connector
preference does not delete research data. Back up and remove the directory through normal
local file management if it is no longer required. No service, daemon, scheduled task or
global package is installed. The application-owned MCP manager closes its workers during
normal application disposal; unfinished jobs are reported as interrupted on restart.

Tools pass the same bundled Connector enablement, Specialist scope and approval gate
as existing built-ins. The Python engine enforces source-scoped HTTPS hosts, limits file
paths to its own incoming/download directories, rejects signed credential-bearing tool
URLs, and disables external-file/network access in local SQL. Downloads are limited to
5 GiB, imports to 20 GiB, SQL to one read-only SELECT/WITH with a 20-second deadline
and 1,000 output rows. ZIP extraction is selected-member only. It never applies for access,
accepts an agreement, solves an access challenge or automatically retries a download.

Patient-level CHARLS/CHNS/SEER/MIMIC/eICU results stay in local CSVs; the bundled adapter
does not expose the engine's `--return-rows` override. Credentials do not establish data
permission. PhysioNet data use with model services remains subject to its current agreement
and model-use policy. Public demos/local synthetic tests do not validate full-data access.

## Development

`python scripts/generate-medical-data-tools.py` regenerates the public TypeScript descriptors
from actual MCP discovery without network access. Keep generated schemas and the Python
engine in sync. The package descriptors do not launch processes; the host adapter supplies
fixed resource paths, managed runtime, provider credentials and storage after authorization.

Python behavioral tests live in `test/medical-data/`; run them with the prepared runtime:

```sh
python -m pytest test/medical-data -q --basetemp <fresh-workspace-test-directory>
python test/medical-data/verify_mcp.py
```

The protocol check exercises all 14 bundled engines using synthetic local files. It never
downloads or probes personally authorized research data. Host adapter tests additionally
cover no-Python access guidance, credential isolation, cancellation and runtime failure.
