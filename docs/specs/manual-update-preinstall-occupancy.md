# Manual update fallback during pre-install occupancy

This amendment to PR #3745's manual-install fallback spec records the user-approved
change of 2026-10-21. It supersedes the blanket exclusion of installation occupancy
from manual instructions. All other artifact, task, save, recovery and native-result
requirements remain in force.

## User-visible behavior

When automatic installation is blocked **only by another running instance using the
installation**, and main can establish that the native installer has not started,
the update dialog offers manual-install instructions. A complete, independently
installable cached artifact must pass the existing main-owned identity, size,
checksum and channel-signature checks before file reveal is enabled. If the artifact
is invalid or unavailable, the existing full-installer website instructions apply.

The instructions prominently require the user to save work, stop tasks, completely
quit Open-Science, and close other instances or stop the services occupying this
installation before running the installer. They state that manual installation does
not automatically resolve file occupancy. A verified artifact is not presented as
permission to install immediately while occupancy remains.

Showing instructions and selecting a file in Explorer/Finder/the file manager do
not start an installer, quit the application, stop another process, or clear the
automatic update's occupancy error. Automatic retry continues to enforce its normal
installation checks. Switching to a new download retains the occupancy instructions.
Back/Escape restores the update view and entry focus in the same dialog.

## Authority and blocking boundary

- Renderer receives eligibility and the occupancy warning from main. It cannot
  enable the exception by sending a path, a trust flag, or an error string.
- The exception is restricted to the known pre-install `other-runtime` condition:
  runtime running, installation unchanged, preparation phase, and no native handoff
  submitted or unresolved. Merely seeing an unchanged version is not evidence.
- Main rechecks runtime ownership, installation-operation protection and active
  work before granting instructions and again before file reveal. It tolerates only
  the identified occupancy condition; it does not ignore a failed safety check.
- An installer running, a pending native handoff, unknown installation outcome,
  unknown occupancy, held installation operation, unconfirmed stop, failed save,
  unsupported configuration or active-work blocker continues to deny manual access.
- A lifecycle change while artifact verification is pending invalidates the old
  grant. A stale result cannot restore file reveal or remove the warning.
- Existing durable native-attempt records retain priority across retries and app
  restarts. This change does not infer native failure or clear pending records.

## Acceptance

| Scenario                                          | Required evidence                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-install occupancy with verified installer     | Main grants conditional instructions; real file checks pass; file manager selects the cached installer; application and occupying process remain running; no installer is started. |
| Occupancy with missing/replaced/corrupt installer | Existing verification removes local access and selects website instructions; occupancy warning remains.                                                                            |
| Occupancy clears                                  | Recheck can remove the conditional warning only from fresh main evidence; normal automatic update checks remain unchanged.                                                         |
| Native pending/running/unknown                    | Instructions and file reveal remain blocked, including when outward status resembles pre-install occupancy.                                                                        |
| Other safety failures                             | Save, task, runtime and uncertain-occupancy failures do not use this exception.                                                                                                    |
| State changes during inspection/reveal            | Stale grants do not expose the installer or overwrite the new state.                                                                                                               |
| Both dialogs and locales                          | Same instructions and safety behavior in legacy/runtime update dialogs; Back/Escape/focus and eight translated catalogs pass regression checks.                                    |

Unit/contract tests, browser fixtures and packaged Windows evidence are reported
separately. A real cached-file reveal is not native installation acceptance. The
unsigned test channel does not certify production publishers. The independent
`local-update-validation` feature remains outside this PR; any packaging harness
and machine-specific evidence stay in the external acceptance directory.
