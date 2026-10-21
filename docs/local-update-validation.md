# Local packaged update validation

The external runner freezes the current workspace and builds low-version A and target-version B from that same snapshot. It opens only A and serves the actual B ZIP from an independent IPv4 loopback HTTP server. Discovery, download, checksum verification, task checks, service shutdown and recovery use the application update path. A compile-only adapter intercepts the native handoff or injects a handoff failure. It never installs, replaces the app, starts B or reports an installed outcome.

## Requirements and preparation

Use a native macOS arm64/x64 host with Node 24, npm, Xcode Command Line Tools, network access for locked resources and several GB of free disk. The first preparation installs dependencies twice and builds A, B and an ordinary application package; allow several minutes. Local builds use the existing ICNS and repository ad-hoc signing hook. Production publisher signing and notarization are separate acceptance work.

Run from the task's worktree:

```sh
NODE_USE_ENV_PROXY=1 npm run validate:update:local -- prepare --a 0.0.1 --b 0.0.2
```

`NODE_USE_ENV_PROXY=1` enables Node's existing proxy configuration when required; it does not disable download verification. The command prints its absolute run directory, normally under `~/Library/Caches/Open-Science-local-update-validation/<UUID>`. `--parent /absolute/outside/workspace` selects another location. B must be newer than stable `x.y.z` A, and A must exceed `0.0.0`.

Preparation captures tracked and nonignored new files, including working changes and deletions, without changing the index. It compares the inventory and contents before and after capture and refuses a changing snapshot. Each build gets a fresh source copy, with only package versions overridden. Dependencies, native components, micromamba and Node follow the repository's pinned preparation commands. No original workspace data, credentials, ignored outputs or dependency directory is copied.

The ordinary/test bundle guard runs against the frozen source. Full application scans cover ASAR, unpacked dependencies and the backend. An ordinary package is rebuilt with the test define disabled and checked for test adapters, runtime activation inputs and external tooling. Runtime flags cannot enable the adapter in that package. Preparation also exercises the real B ZIP through the test-channel manual archive verifier without starting either application, retaining its independent result. Preparation failure retains logs and launches no application; an unavailable local source never falls back to production.

## Credential isolation and staging

The runner **never changes a Keychain search list or default Keychain**, including under an altered HOME. It never creates, unlocks or resets a credential database. A changed HOME is insufficient proof that Security.framework is isolated. Ordinary login credentials must remain untouched.

A packaged scenario requires an independently provisioned, scenario-owned Keychain in a dedicated disposable macOS login account or VM. The runner queries metadata only and refuses startup unless the default and search scope contain exactly the scenario database. Application startup also checks the effective scope and rejects shared application accounts in the System database. Production credential helpers remain active.

Stage a scenario before provisioning; this creates isolated app/data/config/profile/cache directories and fixed nonsecret test data, without opening A or starting the update server:

```sh
npm run validate:update:local -- stage /absolute/run-directory --scenario manual-local
```

The command prints the staged scenario directory. Its `local-update.json` names `homeRoot` and `keychainPath`. Provision that database and isolated preferences independently **inside the disposable account/VM**, using its supported Keychain administration workflow. Do not run a CI Keychain-list replacement script on a daily Mac. The runner deliberately provides no automatic credential provisioning command. If the host cannot prove this isolation, packaged interaction acceptance remains **not executed**, even when preparation succeeds.

Resume the exact staged scenario after provisioning:

```sh
npm run validate:update:local -- run /absolute/run-directory --scenario manual-local --staged /absolute/scenario-directory
```

For an already provisioned environment, `start` prepares and runs, while `run` creates a fresh scenario. Each scenario owns its own A copy, HOME, config, data, Electron profile, update cache and logs. Fixture creation happens offline before startup and is never repeated on resume or recovery. Source health is verified before A starts.

## Scenarios and real interaction

Operate A through its update UI. The runner does not synthesize ready/error renderer state, press update buttons, shut down A or recover its services. The fixture project **Local update validation** contains a history, attachment, Notebook output `LOCAL_UPDATE_SAVED_OUTPUT: 42` and nonsecret settings. `fixture-manifest.json` provides a local shell `taskCommand` and `recoveryWriteCommand`; the latter must run in the same workspace after application recovery. A write performed before the recorded recovery does not count.

| Scenario                                      | Required operation and evidence                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundary`                                    | Download B and install through real shutdown; intercept the handoff and retain the recovery action. Native installation remains unexecuted.                                                                                                                                                                      |
| `handoff-failure`                             | Inject failure only after verified download and confirmed shutdown. Recover in A, read existing data and run `recoveryWriteCommand`.                                                                                                                                                                             |
| `manual-local`                                | Reach handoff failure, recover, enter manual instructions and click Show in Finder. Independently observe Finder selecting the exact verified ZIP.                                                                                                                                                               |
| `manual-non-standalone`                       | Download the actual updater-only ZIP with matching feed checksum, reach failure and recover. Only the website route is available. The ZIP contains updater metadata referencing a separate missing application payload; its name is outside the standalone release contract. No eligibility boolean is injected. |
| `manual-download-failure`                     | The source returns a real 503 for ZIP transfers. A offers retry and the website route; no partial file is revealed.                                                                                                                                                                                              |
| `cache-corrupt-entry`, `cache-delete-entry`   | After real recovery, the observer corrupts or deletes only this scenario's recorded completed download. Wait for the terminal confirmation, then enter manual instructions; A must switch to website instructions.                                                                                               |
| `cache-corrupt-reveal`, `cache-delete-reveal` | Enter local instructions first. After archive verification, the observer corrupts or deletes the actual cache file. Wait for confirmation, then click Show in Finder; A must recheck and switch to website instructions without revealing.                                                                       |
| `same-version`, `lower-version`               | The source advertises A or `0.0.0`; A reports up to date without an available update or handoff.                                                                                                                                                                                                                 |
| `download-cancel`                             | Cancel the first deliberately throttled actual transfer after progress, then retry a normal verified transfer. Logs must prove interruption and retry.                                                                                                                                                           |
| `network-failure`                             | The first ZIP GET returns 503; retry a real verified download.                                                                                                                                                                                                                                                   |
| `checksum-failure`                            | The feed checksum is wrong while ZIP bytes are unchanged; actual download verification rejects it.                                                                                                                                                                                                               |
| `corrupt-artifact`                            | The feed checksum is correct while transmission flips an actual byte; verification rejects it.                                                                                                                                                                                                                   |
| `active-task`                                 | Run `taskCommand`, wait for observed PID, try install and verify the active-task block. Stop through A, retry after PID exit, recover and write; the original task must not restart.                                                                                                                             |
| `shutdown-failure`                            | The source owns a temporary hard link to this scenario's runtime lock, producing an actual lock-integrity shutdown refusal. Release only that link using the printed local diagnostics page after refusal, then recover in A and write. No process is killed.                                                    |

The local instructions verifier checks the actual ZIP checksum and safe paths, extracts into this run's cache, verifies the complete ad-hoc signed application, and checks the test-channel bundle identifier, target version and native architecture. This exception is compiled only into test builds; it does not relax production publisher validation.

A reveal invocation alone is insufficient proof of selection. After Show in Finder, run this independent metadata observer while Finder has exactly that file selected:

```sh
npm run validate:update:local -- observe-finder /absolute/run-directory --staged /absolute/scenario-directory
```

It reads Finder's selection with AppleScript and records success only when the exact path equals A's recorded reveal target. It does not select the file, start an installer or open a website. Keep a screenshot for visual review where available. Website instructions can be inspected without browser navigation; only the explicit Download from website action should open the official full-installer download page. A browser route requires separate actual browser evidence and is always listed separately from adapter acceptance.

Use A's own quit action when finished. The independent source survives A's shutdown or exit. `Ctrl-C` ends observation and closes only the runner's source; it leaves A and its backend under application control. A retained screen may still be closed through A. For further downloads, start a fresh observed scenario.

## Reports and retained evidence

```sh
npm run validate:update:local -- report /absolute/run-directory
```

`result.json` and `summary.md` retain per-scenario passed/failed/not-run results, source commit and SHA-256 snapshot, A/B versions and archive SHA-256/SHA-512/size, actual fault evidence, runtime PID exit/recovery, data retention and recovery writes. Passing one scenario does not pass the full matrix. Evidence must show the source became ready before A, survived app shutdown/exit, then closed and released its TCP port. Any installed outcome, native installer invocation or B startup contradicts the adapter contract and prevents an overall pass.

| Location                                                        | Evidence                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `source.json`, `source/`                                        | Immutable snapshot identity and per-file inventory                     |
| `builds/{a,b}/`, `build-{a,b}.log`                              | Same-source preparation, dependencies and build logs                   |
| `artifacts/{a,b}/`, `build.json`                                | Packaged A/B, actual archives, blockmaps and checksums                 |
| `artifacts/production/`, `production-package-verification.json` | Unlaunched ordinary package and full package boundary scan             |
| `build-boundary-tests.json`                                     | Actual ordinary/test main bundle checks                                |
| `scenarios/<name>-<UUID>/local-update.json`, `launch.json`      | Owned isolation and A-only launch                                      |
| `app-events.jsonl`, `server-events.jsonl`, `observations.jsonl` | Real application states, requests, faults and independent observations |
| `application.log`, `fixture.log`, `fixture-verification.json`   | Diagnostics, fixed data retention and post-recovery writes             |
| `keychain-verification.json`                                    | Read-only metadata scope and unchanged normal-login preferences        |

Tests and compile-only interception cannot establish production signing, notarization, native replacement, B startup, post-update data retention or Windows/Linux acceptance. Reports keep these **unverified**. Preserve failed evidence until explicit cleanup.

## Native acceptance still required

Use the platform's dedicated disposable desktop environment and a complete same-snapshot B artifact. Disable the compile-only interception by building the ordinary package; never interpret a test adapter exception as native success. Use an isolated test installation/data set and retain commands, logs, versions, checksums, PID/installer state, target startup and post-update read/write evidence.

| Platform       | Repeatable acceptance outline                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS ZIP/DMG  | Build A/B with `npm run build:mac -- --publish never` in their versioned snapshot copies with production signing credentials. Install A in the disposable environment, exercise native handoff/failure/restart recovery, reveal the downloaded full artifact, fully quit and replace from that artifact. Reopen from Applications, verify B and existing test data. Record publisher signature/notarization separately. |
| Windows NSIS   | Build with `npm run build:win -- --publish never` on a dedicated Windows VM. Record actual block/range requests and prove reconstructed EXE checksum equals full B. Record full-download fallback separately. Exercise native installation failure and restart recovery, then manually install the exact downloaded EXE in the original test location, reopen B and check data.                                         |
| Linux AppImage | Build with `npm run build:linux -- --publish never` on a desktop Linux host. Launch the actual AppImage, exercise native handoff/recovery and file-manager reveal, fully quit, replace the original file, restore executable permission if needed and reopen B with retained data. An extracted directory is insufficient.                                                                                              |
| Linux DEB      | Use a restorable Debian/Ubuntu desktop VM and the built DEB. Exercise real package-manager authorization, package scripts, installation failure/restart recovery and file-manager reveal; install the downloaded DEB, reopen B and verify data. Container package-script checks do not prove desktop authorization.                                                                                                     |

These native recipes are acceptance work to execute and record; their presence in this document is not evidence that they ran.

## Cleanup and tests

Quit every A through the application and end observation before cleanup:

```sh
npm run validate:update:local -- clean /absolute/run-directory
npm run test:update:local
```

Cleanup requires a canonical absolute path and matching ownership receipt. It checks process commands and open files, retains the run if any process still references it or usage cannot be established, and never stops processes. It never performs a process-name bulk kill, restores a Keychain list, or automatically deletes failed evidence.
