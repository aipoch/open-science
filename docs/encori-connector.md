# ENCORI connector

The built-in ENCORI connector exposes ten tools through `host.mcp("encori", method, args)`.
Open the generated `mcp-encori` Skill for each tool's exact schema, result shape and example.
The Windows `setup.ps1`, Python wheel and generated `encori.json` belong to the older custom
Connector distribution. The built-in connector does not require those installation files.

## Moving from the custom connector

The old installer generates a custom Connector named `encori`. That name is reserved by the
built-in connector in versions containing this implementation. Existing custom settings remain
stored, but the conflicting custom route is excluded from dispatch and Skill generation. Importing
the old `encori.json` is rejected as a reserved name. Disabling the built-in connector does not
release its reserved name.

To use the built-in tools:

1. In Settings, remove the old custom ENCORI Connector through the existing removal action.
   This step is performed by the user; upgrading does not delete or rename that configuration.
2. Use the built-in ENCORI entry and load its current `mcp-encori` Skill in a new conversation.
3. Update existing calls from, for example, `encori_query_mirna_targets` to
   `query_mirna_targets`. The ten available methods lose the `encori_` prefix; the server
   name remains `encori`. Degradome is currently withheld as described below. Check the current
   schema before reusing an old call.
4. Verify a small query first. Zero rows and an upstream service error are different results.

Removing the custom settings entry does not uninstall the Python environment created by the
old installer. Follow the old distribution's uninstall instructions separately if that environment
is no longer needed. This connector does not perform automatic migration, uninstall or alias routing.

## Current tool availability

`query_degradome_events` is temporarily absent from the registry, Settings tool list and generated
Skill. Its implementation and `hg19`/`mm10` contract remain available internally for regression tests.
The supplied guide records 15 rows for an `hg19` TP53 query on 2026-09-08. That historical
success does not establish current provider availability. On 2026-10-09,
small `hg19` and `mm10` probes returned HTTP 200 with a missing `degradome_ref.txt` PHP error;
the provider rejected the `hg38` assembly from its online example. This is a provider failure,
not a reason to substitute assemblies or broaden filters. Restore public registration after a
successful official query is verified. No automatic retry loop or availability-based routing is added.

## Download permission

Main Agent calls to `download_bulk_dataset` default to Ask on fresh settings and the first decode
of older connector settings. Decoding does not write settings. An initialization marker is retained
on the next normal save so an explicit Allow, Ask or Block choice survives reload. Existing policies
for other tools and the connector's Skip approvals selection are preserved.

The standard permission rules still apply: Block wins, Skip approvals can bypass Ask, and remembered
grants can satisfy approval. Specialist capability scopes follow their existing independent policy.
To require approval for Main downloads, leave this tool at Ask and keep ENCORI Skip approvals off.
The tool description also limits downloads to explicit user requests; policy approval alone does
not verify the meaning of the user's natural-language instruction.

## Results and local files

Query records preserve official field values. `total_records` counts rows in the received response;
`returned_records` is the displayed preview. Read `raw_response_path` before drawing conclusions
about the complete response. Successful table queries save the full original response even when
the preview contains every row. Each call creates a separate file; these files are user data,
not a reusable cache, and are not automatically deleted.

Paths refer to the computer running Open Science, including when a Notebook uses a remote compute
host. The default output directory is `~/OpenScienceConnectorData/encori`. Set `output_dir` or
`destination_dir` explicitly when needed. A local saved path is not automatically uploaded to a
project or remote compute host.

Reference calls fetch the official ZIP anew. Listing reads archive metadata without decompressing
tables or saving their contents. Selecting an exact table name decompresses only that table.
Complete selected tables return all rows without creating files or requiring a writable output
directory; `raw_response_path` and `saved_path` are `null`. Only a truncated reference preview saves
the full original table and returns those paths. Reference contents are checked and parsed before
any file is saved. This matches the older wheel's reference-table behavior.
Bulk discovery uses HEAD requests when availability checks are enabled and never downloads the
datasets. Download a bulk dataset only when the user requests it.

## Download recovery and failures

Downloads never replace an existing destination. Completion requires size checks when an official
size is available, gzip integrity verification and publication of the final file. Interrupted
downloads retain `.part` and `.part.meta.json` for the same filename and directory. Resumption
requires matching official identity and valid HTTP range responses; a changed identity is rejected.

New metadata is published atomically and records its owner, version and exact partial-file path.
All three fields must match whenever any receipt field is present, including when `.part` already
exists. Older metadata containing only official identity fields remains supported alongside a
matching partial file; it cannot recover orphan initialization.
If initialization stops after metadata publication but before creating `.part`, the same call may
recover only when that receipt and the current official identity match. Unowned orphan metadata,
legacy partial files without identity metadata and mismatched receipts are preserved for inspection.
Concurrent downloads of the same file in this app process are rejected.

Cancellation is checked before file publication. After the publication commit point, cancellation
cannot undo an already saved user file. Cleanup failures after successful publication are reported
as warnings. The connector does not scan or delete unrelated files.

Tools return `ok: false` with an error code for provider and filesystem failures. Schema rejection,
permission rejection, caller cancellation and the execution deadline propagate as errors.

Table queries and reference calls have a 120-second total deadline, bulk listings 300 seconds,
and bulk downloads 3600 seconds. The deadline covers retries and waits, and for downloads also
verification and publication. Network requests have a 45-second idle timeout. Unlike the old
wheel's download configuration, the built-in connector has a finite total deadline. Increasing
an outer Notebook execution timeout does not extend it. A timeout before publication is not a
completed download; retry the same filename and directory to recover retained partial data after
identity and range checks. Already published files remain subject to the cancellation boundary above.

`upstream_parameter_error` means the provider explicitly rejected parameters;
`upstream_response_error` means it returned an error page or server warning. Do not broaden query
filters to recover from either failure. The internal degradome implementation retains the supplied
connector's `hg19` contract; it does not silently substitute an assembly. A provider-side missing
reference file must be reported as an upstream failure rather than an empty result.
