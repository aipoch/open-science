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

An intact application entry can resume the original retained target through Electron's native
Squirrel updater. Recovery repeats bounded same-installation shutdown and occupancy verification
before submission. A verified installed target becomes a startup ticket, preserving the original
profile until backend, window and data readiness. The ticket also owns exact retained-file cleanup,
including interrupted downloads. Unknown extra files are preserved rather than recursively deleted.
No resident recovery service or independent historical-version rescue tool is installed.

The owner is `src/main/update/mac-update-handoff.ts`; installation-scoped records and startup
tickets live in the existing installation-state directory. Retained files live under the current
account's application-data `mac-update-handoffs/operation-*` directory. Cancellation before native
submission removes the operation's retained files. Submission keeps recovery material until
verified readiness; a startup ticket survives a crash during settlement. Deleting the app during
an unfinished update does not automatically remove these external records. They are retained for
recovery; this change does not add a system-wide uninstall hook or scan unrelated directories.

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

The acceptance CLI currently implements the normal update scenario. Additional signed failure,
active-work, cancellation and interruption scenarios remain required. Unit tests and native fixtures
must not be relabeled as those real-package results. Both arm64 and x64 need normal-update evidence;
arm64 is the primary fault-scenario architecture.

## Remaining release gates

- Upstream authorization for the exact reviewed native artifacts and Developer ID signed packages.
- Normal signed update and the finite fault-scenario list, including real work, save failures,
  cross-profile shutdown, cancel/retry, interruption, cache repair and recoverable blockers.
- A supported ordinary launch entry after an update removes the main executable. The current
  `.app`/Squirrel layout does **not** satisfy this: LaunchServices refuses a missing executable,
  and application-local recovery cannot run. The native fixture records that failure. Intact-entry
  recovery is not a substitute, and this requirement has not been changed to manual reinstall.
- A frozen package candidate with complete per-scenario provenance and Windows regressions
  appropriate to shared changes.

The historical ad-hoc Mac packages and Windows CI results are not signed Mac update evidence.
No merge, release, production feed change, signing bypass or automatic-start assertion follows from
this document or from the presence of the workflow.
