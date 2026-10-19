# Optional research reproduction description (stage-one draft)

This draft describes an **ordinary Artifact** named, by convention,
`research-reproduction.json`. Its content helps identify the materials and stated
scope of a future research reproduction. It is not a new `.science` archive format,
an executable installation manifest, a permission grant, or proof that an experiment
has been reproduced.

The implementation in `src/shared/research-reproduction.ts` provides pure, bounded
inspection, portable-path checks, archive-inventory checks and material resolution.
It does not download, unpack, install, execute, start a service, prompt a model or
register an application/API/UI entry point. Importing an Artifact with this content
does not run it. Native Artifact reproducibility recipes, their sealed capture rules
and `.science` v1 remain unchanged.

## Content and compatibility

The description has `format: "open-science-reproduction-description"` and
`descriptionVersion: 1`. The filename is a discovery hint, not authority. Parsing
returns `valid`, `invalid`, or `unsupported`. A positive integer version newer than
1 returns `unsupported` after bounded plain-JSON validation; an older client may
still import and display the ordinary Artifact. This inspector is not installed in
the `.science` importer, so an unsupported or invalid description does not change
normal package admission.

The description must fit in 512 KiB of UTF-8 JSON. The inspector rejects custom
prototypes, accessors, cycles, sparse arrays, non-JSON values and reserved object
keys (`__proto__`, `prototype`, `constructor`). Limits include depth 24, 50,000 JSON
nodes, 1,000 materials, 32 plans, 100 parameters/secret slots and 10,000 archive
members. Individual material files are limited to 32 GiB and declared restored
content to 256 GiB. These are description admission ceilings, not resource budgets
or permission to allocate that much disk space.

The JSON text parser also rejects duplicate object fields, including differently
escaped spellings of the same key, rather than silently selecting the last value.

Each object has a closed set of fields. Future content must use a new description
version rather than attach fields to `.science`'s manifest or native recipes.

## Minimal example

The digests and commit below are illustrative and must be replaced with the actual
values. Archive entries describe the archive's own relative member names. The
example restores the contained file at `source/project/package.json`.

```json
{
  "format": "open-science-reproduction-description",
  "descriptionVersion": 1,
  "title": "Fixed engineering materials",
  "materials": [
    {
      "key": "source",
      "role": "source",
      "availability": "included",
      "filename": "source.tar.gz",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sizeBytes": 100,
      "restorePath": "source",
      "archive": {
        "format": "tar.gz",
        "entries": [
          {
            "path": "project/package.json",
            "type": "file",
            "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "sizeBytes": 40
          }
        ]
      },
      "source": {
        "repository": "https://github.com/example/project",
        "commit": "cccccccccccccccccccccccccccccccccccccccc"
      }
    }
  ],
  "plans": [
    {
      "key": "engineering",
      "title": "Inspect fixed engineering materials",
      "scope": "engineering-check",
      "materialKeys": ["source"],
      "claim": "Checks engineering materials; does not verify a research conclusion.",
      "limitations": ["Stage one does not execute the experiment."],
      "entrypoints": [{ "materialKey": "source", "path": "project/package.json" }],
      "requirements": { "node": ">=22" }
    }
  ]
}
```

## Materials and local resolution

Every material has a unique `key` and a `role`: `source`, `data`, `checkpoint`,
`reference`, `script`, `configuration`, or `documentation`.

- `included` requires `filename`, `sha256`, `sizeBytes`, and `restorePath`. Optional
  `archive` declares `tar`, `tar.gz` or `zip`, with an inventory of files and
  directories. Optional `source` records a public HTTPS repository and a complete
  40- or 64-character lowercase hexadecimal commit. A fixed commit records origin;
  it does not prove that an arbitrary archive corresponds to that commit.
- `external` requires a public description and optionally a public HTTPS URL.
  Stage one does not retrieve external materials or mark them available. A later
  verified acquisition step is needed before external content can be executed.
- `withheld` requires only the logical key, role and a public description of the
  omission. It cannot contain a filename, private path, URL, checksum or payload.
  The key and explanation must themselves be safe to share.

Source URLs cannot contain credentials, query strings or fragments. The draft does
not offer a place for private download tokens. Code and data licensing and permitted
redistribution should be recorded in accompanying ordinary documentation Artifacts.

Resolution accepts a caller-provided `researchId` and a catalog of verified managed
Artifact Versions associated with that exact imported research. The catalog is a
capability supplied by the caller, not an authority supplied by the description.
Candidates with a different `researchId` are ignored. Do not pass a Project-wide
catalog with every row relabeled as the current research.

An included material matches by SHA-256 **and** byte length. `filename` is only a
display/diagnostic hint; it never permits substituting different content. Identical
content aliases produce a sorted list of local `artifactIds`, and no arbitrary
alias is selected. `contentAvailable: false` identifies metadata whose payload was
excluded or is unavailable. Results are `available`, `external`, `withheld`,
`missing`, or `mismatch` (a same-name or same-digest candidate disagrees).

The resolver does not read or hash bytes. Its caller must obtain checksums,
availability and sizes from managed Version/content verification, and must recheck
the content when acquiring it for restoration. `available` means the specified
material was resolved, not that the plan is executable or its claim verified.

The description carries no local Project, Session, Artifact Version or storage-key
identity. Those identities can change during `.science` import while ordinary
Artifact bytes remain unchanged. `restorePath` and archive member paths are logical
relative paths, not author-machine addresses. The descriptor's own checksum is
computed by its managed Artifact Version; it is not embedded in its own body.

## Restoration and archive inventories

Paths use `/`, contain no empty, `.` or `..` component, and reject absolute paths,
drive prefixes, backslashes, control characters, Windows reserved names, trailing
dots/spaces and other nonportable filename characters. Checks detect exact,
case-insensitive and NFC-normalized collisions, including conflicting implicit
parent directories. A file cannot be another file's parent directory. Included
materials cannot have duplicate restoration roots or overwrite each other's files.

An ordinary file restores at `restorePath`. For an archive, `restorePath` is its
destination directory and every member is relative to that directory. Only `file`
and `directory` entries are supported. Symlinks, hardlinks, devices, sockets, FIFOs
and additional member fields are rejected. Directory paths have no trailing `/`;
an archive reader must normalize only the conventional directory terminator before
calling the checker, without resolving or silently rewriting unsafe member paths.

`validateResearchReproductionArchiveEntries` checks one bounded inventory.
`compareResearchReproductionArchiveEntries` compares a declared inventory with an
inventory independently observed by an archive reader. File names, lengths and
digests must match exactly. Explicit parent-directory headers may be omitted;
unexpected directories are rejected. These helpers do not inspect archive bytes,
verify a compression stream or secure a filesystem destination. A future
materializer must verify the archive content checksum, enumerate actual members,
compute their digests and sizes, enforce extraction budgets, and protect destination
ownership against existing files, symlinks and concurrent changes. A manifest by
itself never authorizes extracting an archive.

## Plans, parameters and secret slots

A plan has a unique `key`, `title`, required `materialKeys`, `claim`, `limitations`
and an explicit scope:

- `end-to-end`: declared original-input workflow.
- `downstream-only`: begins with retained intermediate data or a checkpoint.
- `alternative-conditions`: changes conditions such as model or data.
- `engineering-check`: validates setup or engineering behavior, without claiming
  scientific reproduction.

These are author declarations, not evidence-backed outcomes. A plan that refers to
external/withheld/missing materials is not made executable by being structurally
valid. Compatibility choices, substitutions, checkpoint validity and scientific
comparison are deferred to later runtime/reporting work.

Optional `entrypoints` identify a required material and, for archives, a declared
file `path` inside it. For an ordinary file, omit `path`. Optional `arguments` are
untrusted descriptive strings; this draft does not interpret shell syntax or run
them. `requirements` may record `node`, `platforms` (`darwin`, `linux`, `win32`) and
a similarly addressed `lockfile`. The Node expression is bounded declaration text;
actual version/constraint evaluation and runtime acquisition are not implemented.

Optional `parameters` contain unique keys, descriptions, `string`/`number`/`boolean`
types and matching optional defaults. They are for non-sensitive values only.
Optional `secrets` contain `key`, `description`, `required`, `environmentVariable`
and explicit `planKeys`. They have no actual-value, default, credential-ID or path
field. Secret and non-secret keys cannot overlap; two secret slots cannot target
the same environment variable. Runtime-control variables and `OPEN_SCIENCE_*` are
not valid secret destinations. This schema does not authorize injection. A later
runtime must bind recipient-provided secrets locally for the selected plan, without
persisting/exporting the values or inheriting arbitrary host credentials.

Free text, source files, argument strings and outputs may still contain sensitive
content. Structural slot validation is not a general redactor. Existing export
content checks and explicit review of the actual public materials remain necessary.

## Publication boundary and phase-one evidence

The native package export dependency closure must remain intact. Excluding an
Artifact payload does not remove its native metadata, Notebook source/output,
conversation, reviews or linked evidence. A public fixture must register selected
shareable bytes as new public inputs with a clear explanation of their origin,
rather than attach a private original Version and assume its dependencies vanish.
Original research stays unchanged; the public description must not represent its
selected input copy as the complete original evidence chain.

Phase-one compatibility tests exercise ordinary Artifact export/import, remapped
local IDs, checksum-based resolution, omitted payloads and the actual export
closure. Both an intentionally linked private upstream example and a clean selected
public-input fixture are needed. Known private sentinel content must not appear in
the latter's records, history, Notebook material or objects. Such fixtures establish
the tested boundary, not a finished publication or automatic de-identification tool.

This draft adds no mandatory feature, root archive entry, execution recipe field,
Session classification, database research model, command registration or UI. The
broader implementation boundary and technical validation belong to
`research-reproduction-stage1.md`.
