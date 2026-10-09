# Portable research material foundation

This foundation describes research inputs as ordinary Artifact files and provides a Main-only,
bounded local-service capability for Notebook engineering checks. It preserves `.science` v1,
Session persistence, existing import/export recipes, and ordinary persistent Shell behavior.

## Portable materials

`research-reproduction.json` is optional content, not execution authority. Its versioned parser
validates portable restore paths, hashes, archive manifests, declared roles, and explicit sharing
states. A recipient can distinguish included inputs, withheld inputs, and external prerequisites
without interpreting missing data as an empty successful result. Unsupported future description
versions remain unsupported rather than being guessed.

See [the description reference](research-reproduction-description.md) for the schema and examples.
The [source snapshot helper](../scripts/research/README.md) prepares a bounded, deterministic Git
snapshot and records exact commit/tree identity and selected committed paths. It does not read
working-tree changes or untracked files; its explicit
path exclusions include common environment, cache, and dependency directories. Publication still
requires content review because the helper is not a secret detector.

The package integration tests use the existing Artifact/Notebook repositories and exporter/importer.
They verify exact public input bytes, remapped source references, and exclusion of unselected
private source content. No manifest field or mandatory package entry is added.

## Bounded local services

The service capability is issued by trusted Main composition, never by a research description,
Shell command, SDK request, or package. On native macOS it permits exactly one private Unix socket
owned by one Notebook execution. It does not open a TCP listener or grant access to other Unix
sockets. Unsupported target platforms reject this capability.

The Node preload adapts a declared loopback HTTP port to that socket. It rejects unexpected ports,
hosts, socket locations, and extra listeners. Ordinary child helpers which never listen can inherit
the preload without consuming the socket. An optional private generation proof is served by the
adapter on the same connection as the service; its values are removed from the application-visible
environment after listener initialization.

A trusted Notebook runtime can opt into bounded Shell execution. Completion, cancellation,
timeout, spawn failure, and shutdown retain the original process/sandbox cleanup ownership until
termination is verified. Failed cleanup blocks another bounded execution in that lane and can be
retried; it is not treated as a successful result. The default runtime keeps its existing persistent
interpreter and working state.

## Verification and scope

The focused suites cover description parsing and material resolution, snapshot exclusions, native
socket validation, preload behavior, process-tree ownership/cleanup, and `.science` round trips.
On macOS, real sandbox integration tests check that the declared socket works while TCP listeners,
other sockets, symlink substitutions, and private-file access remain blocked. The real Notebook
service fixture verifies normal completion, cancellation, timeout, and cold recovery.

The optional Tuanzi case in `src/main/notebook/research-service.macos.integration.test.ts` is
opt-in through `OPEN_SCIENCE_STAGE1_TUANZI_MATERIALS` and uses local supplied files; it is not
required to run the generic tests. Synthetic fixtures demonstrate engineering behavior, not a
scientific finding or a model-backed experiment.

This foundation does not yet expose public inspect/prepare/execute APIs, private execution profiles,
project viewers, browser recording, or Replay controls. Those integrations can depend on these
contracts without making navigation or a particular research project part of the execution owner.
