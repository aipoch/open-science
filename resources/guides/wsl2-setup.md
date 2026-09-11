<!-- wsl-setup-guide-version: 1 -->

# Set up WSL2 Bash

This guide is bundled with this Open-Science release and is loaded only for an explicit WSL setup or repair conversation. It governs setup of the WSL2 Bash shell runtime. It does not configure a Jupyter kernel, replace the distro's package manager, or install a custom Linux kernel.

## Safety and scope

- Begin with `wsl_setup_diagnostics({})`. Treat its `revision`, distro candidates, selected and activated targets, checks, operation state, failure, and recovery advice as authoritative. Re-run it after every change and after an app or Windows restart.
- Use only the five `wsl_setup_*` tools below for app-owned WSL setup actions. Do not substitute `notebook_execute`, package-management tools, or arbitrary background shell commands for host configuration.
- Never ask for a Linux password in conversation. Account-initialization and other interactive prompts belong in the visible terminal opened for the exact target.
- Do not paste environment variables, credentials, home-directory listings, or arbitrary command output into the conversation. The diagnostics tool returns a bounded, allowlisted snapshot.
- Do not assume an install finished when its outcome is interrupted or unknown. Re-run diagnostics and follow its recovery advice before choosing another action. Do not replay a mutating operation while another operation is running or its result is uncertain.
- Opening a terminal is only a handoff to the user; it is not evidence that the requested change completed. Wait for the user, then refresh diagnostics.
- A `wsl --shutdown` affects every running distro and may interrupt Docker. Explain that impact and obtain permission for that specific operation before asking the user to run it.

## Available setup tools

The following tools are available only to a local conversation that Open-Science has explicitly bound as a WSL setup session:

- `wsl_setup_diagnostics({})` refreshes diagnostics and returns the version-matched guide, a new revision, and the current bounded support snapshot.
- `wsl_setup_install_platform({})` starts the journaled Windows WSL platform installation. Windows owns the UAC prompt. Handle cancellation, restart-required, failed, and unknown outcomes as distinct results.
- `wsl_setup_install_recommended_distro({})` installs the app's recommended distro only when a fresh diagnostic probe confirms that no selectable distro is installed.
- `wsl_setup_select_profile({ distro, user, expectedRevision })` saves a candidate WSL2 distro and non-root Linux user, then re-probes it. Use the latest diagnostics revision; stale requests are rejected. Saving a candidate does not activate WSL2 Bash.
- `wsl_setup_open_terminal({ target: 'powershell' })` opens a visible Windows PowerShell terminal. `wsl_setup_open_terminal({ target: 'distro', distro })` opens an installed WSL2 distro for first launch or account setup. Add `user` only for the currently selected user that diagnostics has already verified.

The setup conversation has no root package-install tool. For a selected non-root profile with a supported `/usr/bin/apt-get`, Settings offers a separate user-confirmed action that installs only the detected missing runtime packages as WSL root. Do not replace that action with a `sudo` command or imply that the selected runtime user must belong to sudoers.

There is no activation tool in the setup session. Once diagnostics report the saved target ready, guide the user back to Settings and let them choose **Use WSL2 Bash**. That action uses the app's existing activation and rollback workflow.

## Decision path

1. If the platform is not installed, use `wsl_setup_install_platform({})`, then refresh diagnostics. A restart-required result ends the current configuration phase; continue only after restart and a fresh probe.
2. If diagnostics report no selectable distro, use `wsl_setup_install_recommended_distro({})`, then refresh. Docker's internal distros are never valid targets.
3. If an installed distro needs first launch or has no usable default-user identity, open that exact distro in a visible terminal without specifying `user`. Ask the user to complete the Linux account prompts there, then refresh diagnostics.
4. When several distros are available, ask the user which WSL2 distro to use. Diagnostics report each initialized distro's default user from the bounded `id -un; id -u` probe. Use that value when it is non-root. If it is root, help the user create or choose a non-root account in the visible distro terminal. Then call `wsl_setup_select_profile` with the latest revision. Treat the returned snapshot, not the successful write alone, as the verification result.
5. When Bash, Python 3, or bubblewrap is missing and Settings offers **Install missing dependencies**, direct the user to that action. It requires explicit confirmation, runs only the fixed missing-package installation as WSL root, and then verifies the original non-root profile. It never adds the runtime user to sudoers and never activates WSL2 Bash automatically. If the action is unavailable because `/usr/bin/apt-get` was not detected, explain that the distro's own package-management instructions are required; do not guess a command from the distro display name.
6. Mirrored networking, namespaces, the user home, and the local NTFS workspace must all pass. If `wslinfo --networking-mode` does not report `mirrored`, explain that the current preview requires mirrored mode. In the visible PowerShell terminal, help the user preserve their existing `%UserProfile%\.wslconfig` content while setting `networkingMode=mirrored` in its `[wsl2]` section. Before editing, save a recoverable backup of any existing file and record its contents or hash. Immediately before writing, check that it has not changed; if it has, read the new contents and reconcile the change instead of overwriting it. Preserve unrelated sections, comments, and settings. A later `wsl --shutdown` affects all distros and Docker, so obtain permission for that exact shutdown before it runs. Refresh diagnostics afterward; do not infer success from the file edit alone.
7. `wsl_setup_select_profile` persists the candidate distro and user through the app's settings owner. Do not edit an Open-Science settings file directly. When every readiness check passes for that saved target at the current revision, direct the user to the explicit Settings activation action.

WSL software version and a distro's WSL generation are separate fields. A distro with `version: 2` does not imply that the installed WSL software version is `2`.
