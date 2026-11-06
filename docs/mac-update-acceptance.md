# Mac update reliability acceptance

The Mac changes in PR #3995 are **not release-certified**. Source-level and native fixture checks
cover installation-scoped shutdown, the existing Squirrel update path, retained target/profile
recovery, and readiness checks. They do not establish a successful signed package update.

## Production behavior

A downloaded update retains its verified ZIP, original target, and startup configuration outside
the replaceable bundle. One installation-scoped owner publishes a bounded close request; peers
attempt saves and normal shutdown. Failed, absent or timed-out save responses do not alone block
installation. Native shutdown rechecks process birth identity and executable ownership; another
installation does not inherit close authority. Occupancy failures retry and use an independent
inspection, retaining unknown results rather than treating them as idle.

The ordinary Finder/Dock entry is a separately signed native `Open-Science.app` launcher. Its
immutable resources contain a verified initial runtime seed and the reviewed recovery controller.
The replaceable Electron runtime lives outside that launcher, so deleting its executable or
interrupting its directory replacement does not delete the ordinary recovery entry. The runtime
retains `com.aipoch.open-science` and its existing publisher identity; the ordinary launcher uses
`com.aipoch.open-science.launcher`. The launcher owns the ordinary Dock icon. The runtime is an
accessory application with its existing Electron windows and menus. Explicit new-instance launches
retain their profile/environment/arguments; ordinary reopen focuses the runtime. File/URL events
are forwarded through LaunchServices, with a fresh bounded attempt and an actual completion reply.
An application that cancels normal Quit keeps its launcher/Dock entry alive.

Normal update discovery/download and replacement still use electron-updater and native Squirrel.
An executable runtime can resume the original retained ZIP through that same updater. When the
runtime itself cannot execute, the native entry claims the same SQLite update-owner lock, validates
the bound original request, and verifies/reacquires its exact package. It quiesces only a Squirrel
job whose program belongs to this runtime, stages and independently verifies the original target,
then runs the existing bounded same-installation save/close and occupancy checks. The controller
uses the verified target's Node and native addon together, including a Rosetta source selecting an
arm64 target; missing required native API exports fail closed. Only then may it repair the runtime
and automatically launch the target. A pending update never falls back to the older seed.

A verified installed target becomes a startup ticket, preserving the original profile until
backend, window and data readiness. The ticket also owns exact retained-file cleanup, including
interrupted downloads. Unknown extra files are preserved rather than recursively deleted. No
resident recovery service or independent historical-version rescue tool is installed.

## Application layout and storage lifetime

The public DMG and the traditional `aipoch-…-mac-<arch>.zip` both contain the ordinary launcher.
The explicitly named `aipoch-…-mac-<arch>-runtime.zip` is an update payload: the updater YAML and
blockmap describe this separately signed Electron bundle. It is not the user installation entry.
Packaging creates both after the runtime's final signature, without changing signed resources or
sharing a staging path between architectures. Ad-hoc/nightly launchers still verify their resource
seal and pin their original seed's designated requirement; that path does not acquire official
publisher trust or enable cross-version automatic updates.

For each canonical ordinary launcher path, the replaceable runtime is stored at:

```text
~/Library/Application Support/Open-Science/RuntimeInstallations/
  sha256(canonical ordinary .app path)/Open-Science.app
```

`OPEN_SCIENCE_MAC_RUNTIME_ROOT` selects an isolated runtime root for acceptance. The runtime's
parent contains `ordinary-entry.json` with exactly `schema`, `wrapperPath`, `runtimePath`,
`runtimeRoot`, and `stateRoot`. Runtime startup verifies this path/hash association and the
launcher's signature/resource seal before using its ordinary installation path or installation
state root. It restores the state root and original profile synchronously, before yielding to
Electron profile/credential initialization. A Squirrel-launched target therefore does not depend
on inheriting the source's command-line switches or launch environment. Original signing identities
are retained; this document does not claim a real Keychain/TCC migration test has passed.

The seed remains inside the ordinary launcher for its lifetime. A first installation extracts it
to its own runtime directory. An initialized damaged runtime without a bound pending update is
reported as an actual recovery error; it is not silently replaced with an older seed. A normal
runtime upgrade does not replace the launcher, change its Finder bundle version, or refresh its
seed. Future changes to the launcher protocol require a compatible ordinary distribution/update
strategy; the fixed controller does not promise compatibility with arbitrary future native APIs.

The supported recovery entry is the same fixed ordinary `.app` path. Moving or copying that
launcher changes its canonical installation identity and selects a different runtime directory;
the existing upgraded runtime and unfinished operation are not silently reassigned to another
installation. A new path can initialize from that launcher's original seed, which can be older
than the runtime used at the previous path. The current change does not promise transparent
post-upgrade relocation/copy migration. This limitation needs explicit release review, rather than
being hidden as an automatic recovery pass. Moving an initial downloaded launcher through the
existing installation flow is distinct from migrating an already-upgraded runtime.

The owner is `src/main/update/mac-update-handoff.ts`; installation-scoped records and startup
tickets live in the existing installation-state directory. Retained files live under the current
account's application-data `mac-update-handoffs/operation-*` directory. Cancellation before native
submission removes the operation's retained files. Submission keeps recovery material until
verified readiness; a startup ticket survives a crash during settlement. Deleting the app during
an unfinished update does not automatically remove these external records. They are retained for
recovery; this change does not add a system-wide uninstall hook or scan unrelated directories.

Native recovery also writes an operation-bound `mac-entry-owned.json` journal before staging.
It names only that operation's exact temporary/discard paths beside its own runtime. After the
exact target passes signature/version verification, recovery removes those owned code copies and
the journal. If recovery is interrupted, the same ordinary entry validates and reuses that journal;
it does not scan or recursively delete other installations. Unidentified leftovers are preserved.
Deleting the ordinary launcher removes its embedded seed, but does not automatically delete the
external runtime, association, installation records, or unfinished update material. These are code
and recovery caches, separate from the original config/profile/scientific data. There is no blanket
uninstall cleanup of application-data trees. User deletion of the entire launcher and its recovery
material is outside the interrupted-update recovery promise.

The close budget is 20 seconds. Recovery's final read-only occupancy inspection has a separate
35-second budget. Recovery download/verification attempts are bounded to 120 seconds, with at most
three original-target downloads. Presentation readiness waits up to 30 seconds. The macOS 12–14
fallback uses the existing POSIX identity-recheck approach; newer systems can bind a signal to an
audit token. The older POSIX path cannot provide the same atomic exec/reuse guarantee as that API.

## Trust and execution

The **Mac Update Acceptance** workflow has three manual modes:

1. `preflight` checks a visible native GUI, a temporary Keychain and a loopback range feed. It needs
   no signing secrets. A preflight pass is not an update pass.
2. `build` calls the existing build workflow twice, at one reviewed SHA, using two increasing plain
   semver versions. A maintainer must set `MAC_UPDATE_TRUSTED_SHA` to that exact SHA in
   `aipoch/open-science`. The workflow bakes `http://127.0.0.1:18761/` into the bundle before signing;
   it does not edit signed resources or publish a release. Missing signing fails the build.
3. `accept` consumes the two successful build run IDs at the same SHA and architecture. It launches
   only the source and an isolated other installation, initiates the update through the real UI,
   and independently observes the successor. It checks version, window/backend, original data,
   and the other installation's before/after data. It never launches a missing successor.

The source and target must also use reviewed native-component artifacts matching their source
fingerprint. Native changes require the existing native producer/signing/publication workflow and
reviewed lock-file update. The acceptance build fails early on a stale catalog; it does not invent
hashes, use old binaries, or create a compiler fallback around this trust boundary.

The acceptance CLI implements the finite M01–M14 normal/failure/active-work/cancellation/interruption
drivers. Their presence does not mean they have run with signed packages. Unit tests and native fixtures
must not be relabeled as those real-package results. Both arm64 and x64 need normal-update evidence;
arm64 is the primary fault-scenario architecture.

## Remaining release gates

- Upstream authorization for the exact reviewed native artifacts and Developer ID signed packages.
- Normal signed update and the finite fault-scenario list, including real work, save failures,
  cross-profile shutdown, cancel/retry, interruption, cache repair and recoverable blockers.
- Signed-package evidence for the stable ordinary entry, including an actually missing runtime
  executable/directory and a native recovery writer killed during real replacement. The original
  negative LaunchServices probe remains valid for the old whole-bundle layout; the new positive
  native fixture demonstrates a surviving launcher and repaired target. Neither probe substitutes
  for the signed product scenarios. Actual pinned-Dock clicks and formal publisher/Keychain/TCC
  checks remain unrun; the local read-only Dock accessibility probe lacked authorization and did
  not modify the user's Dock preferences.
- A frozen package candidate with complete per-scenario provenance and Windows regressions
  appropriate to shared changes.

The historical ad-hoc Mac packages and Windows CI results are not signed Mac update evidence.
No merge, release, production feed change, signing bypass or automatic-start assertion follows from
this document or from the presence of the workflow.
