# @aipoch/environment

Python and R environment discovery, provisioning, installation, inventory, exact locks and
crash recovery. This package follows the application release and can also be built, tested and
consumed from its npm tarball without application source.

## Boundary

The package owns filesystem layouts, lease queues, installer strategies, operation journals,
cache coordination, inventory fingerprints, immutable manifests, exact lock capture/restoration
and recovery invariants. Construct each mutable owner once for a runtime root and share it
between Notebook execution and reproduction consumers.

The application owns authorization, session/kernel bindings and notifications, IPC/UI, product
CDN and bundled executable locations, network transport and authoritative process-tree supervision.
Pass those capabilities explicitly. Micromamba discovery accepts `override`, `resourcesPath`,
`runtimeRoot` and standard `PATH`; it does not read product-specific overrides or infer an application
storage directory from the user's home. Installations require an explicit `storageRoot`. Windows
signed candidates require an injected `verifySignature` callback; publisher identity and release
configuration are host policy. The application supplies that policy from build-time signing inputs,
not runtime environment overrides. Exact pinned unsigned binaries remain usable without signing policy. In particular, use `createInstallSpawn`,
`createMicromambaExecutor` and `createExecutableVerifier` with the host's process supervisor.
`NotebookRecoveryCoordinator` requires that verifier; no fallback silently assumes a process is safe.
`EnvironmentPackageMutationOwner` rechecks supplied authorization and repair gates after acquiring
its mutation lease, before recording intent and executing an installer.

Import operations through `@aipoch/environment` and renderer-safe DTOs through
`@aipoch/environment/contracts`. Only explicitly named exports are public; source/dist deep imports
are blocked. An environment manifest's generic execution context belongs to its caller: environment
stores it unchanged without depending on Notebook analysis, session or artifact schemas. Installation
uses `cwd` and an optional generic `context`; the host owns project/session identifiers and maps its
RPC request into this boundary. Context is forwarded to its process adapter without interpretation.

## Safety and integration

- **Scope:** Python/R runtime and package provisioning, installation, locks, inventory, and recovery.
- **Controls:** Authorization rechecks, operation journals, verification hooks, and host-supervised
  execution preserve the documented installation/recovery boundaries.
- **Remaining risks:** Installing or running dependencies can execute third-party code with the
  installer's granted authority. Pinned versions, checksums, and inventory records do not prove that
  a dependency is harmless, vulnerability-free, or suitable for a scientific workflow.
- **Safe integration:** Review package sources and updates; inject constrained network/process
  capabilities, executable verification, and minimal storage roots. Retain backups and confirm process
  teardown before recovery or cleanup. See the application's
  [supply-chain guidance](https://github.com/aipoch/open-science/blob/main/SECURITY.md#dependencies-and-supply-chain).

## Compatibility

Extraction preserves inventory/manifest schema 1, environment lock schemas 1 and 2, immutable
checksum encoding, journal and marker formats, existing runtime/provenance paths, cancellation and
recovery ordering. It introduces no data migration or new persisted states. Missing process or
network capabilities are configuration errors, not authorization or successful recovery.

## Development and verification

Run `npm run build`, `npm run typecheck` and `npm test` in this directory. Package tests own
algorithm, installer, path, Windows cache ACL and recovery regressions. Real application process-tree,
sandbox, startup and Artifact consumer contracts remain with the host.

From the repository root, `npm run check:environment-package` copies package source into a fresh
location, installs declared dependencies, builds/types/tests it, then consumes `npm pack` output
outside the repository. Diagnostics is built as an upstream prerequisite without rerunning its
unit suite. Ubuntu's trusted package selection skips this package's units and isolation check for
host-only changes; environment changes retain downstream host contract coverage.

The shell environment helper exposes `buildShellProcessEnvironment(platform, sourceEnv)`; Notebook
handoff and PowerShell bootstrap protocol variables are added by the host. Historical cache directory
names, ownership markers and internal subprocess framing tokens retain their existing bytes; these
are compatibility contracts, not imports or lookups into application configuration.
