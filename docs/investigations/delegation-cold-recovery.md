# Delegated process recovery after an application restart

A retained macOS process receipt can block explicit child continuation after the app restarts,
reporting `Delegated process recovery is incomplete.` even when the recorded leader and process
group are gone and no process carries the recorded ownership marker.

The cold-recovery marker scan treated a successful environment read without the marker as
suspicious whenever the process could be inspected as the current user. Ordinary desktop
processes therefore prevented recovery indefinitely. This differs from the same-process
Stop/Resume admission fence: all in-memory admission state has been recreated after restart.

The process-tree owner now distinguishes an absent marker from an unreadable environment. A
complete native snapshot with stable identities and no matching marker can satisfy the existing
cold-recovery contract. Unreadable environments, changed process identities, incomplete tables,
a surviving recorded group, and escaped processes with the marker still block cleanup. Scanning
does not grant ownership of unrelated processes or signal them.

The delegated process receipt owner also preserves saved `stronger-ownership-proof-required`
diagnostics. A clean current scan cannot discharge an earlier incomplete observation: the existing
live handle or a proven machine reboot must resolve that evidence. Existing receipt formats and
historical identity-less launch intents are unchanged. No migration or manual receipt deletion is
required for the stale `owned` receipt that triggered this fix.

Validation includes portable native-observation tests, real macOS process receipt reconstruction,
existing process-tree/Notebook consumer tests, and an Electron restart regression using a genuine
spawn receipt. The UI fixture ends its test-owned processes, restores an in-flight session after
relaunch, and reinstates the retained receipt before exercising the production lazy recovery path.
It asserts that explicit continuation creates a new attempt and preserves the old cancelled attempt.
The test does not claim to simulate every possible force-quit timing or arbitrary descendant program.
