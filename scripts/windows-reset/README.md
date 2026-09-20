# Reset Open-Science data on Windows

Use this tool when you intentionally want to start over. Reinstalling the app
retains your data; this tool permanently removes the local data listed below.
It does not repair or back up that data. Copy anything you need somewhere else first.

## Run

1. Save **both** [reset-open-science.cmd](reset-open-science.cmd) and
   [reset-open-science.ps1](reset-open-science.ps1) into the same folder outside
   your Open-Science data directories. When downloading from GitHub, use each
   file's **Download raw file** action rather than saving the HTML page.
2. Exit Open-Science, including its tray process. Finish and close its Notebook,
   agent, headless, and WSL processes. Keep the app closed until reset finishes.
3. Double-click `reset-open-science.cmd` as the Windows user who uses the app.
   Administrator mode is not required; do not run it as another user.
4. Review every listed path. Type **RESET OPEN-SCIENCE** exactly to delete it.
   Any other response cancels. The window stays open to show the result.
5. Start Open-Science again, choose your desired data location, and configure
   providers and runtimes again. Managed runtimes need installation/download.

Windows PowerShell 5.1, included with Windows, is sufficient. The CMD launcher
uses the system PowerShell with `-NoProfile`; execution-policy bypass applies to
that invocation only and does not change your saved execution policy. If your
organization blocks scripts, follow its policy rather than disabling protections.

For a preview without deletion, run from Command Prompt:

```cmd
reset-open-science.cmd -Preview
```

Or use PowerShell directly:

```powershell
.\reset-open-science.ps1 -Preview
```

## What is removed

| Location                                                            | Contents                                                                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%USERPROFILE%\.open-science`                                       | Settings, saved provider credentials, conversations, personal/imported Skills, application databases, agent state, and any legacy data/runtime here |
| `%USERPROFILE%\Open-Science` and legacy `%USERPROFILE%\OpenScience` | Default data, managed workspaces/files, uploads, notebooks, artifacts, models, and runtime                                                          |
| The `dataRoot` saved in `.open-science\settings.json`               | Custom data and runtime, including a location on another local drive                                                                                |
| `%APPDATA%\Open-Science` and legacy `%APPDATA%\Open Science`        | Electron profile, cache, and local browser state                                                                                                    |
| Proven application-owned runtime caches                             | Current and historical cache identities for the default, legacy, and selected data roots                                                            |

Both default and configured locations appear in the preview because an earlier
move can leave runtime/data in the default location. Missing folders are harmless.
No disk-wide scan is performed. Abandoned custom locations that are no longer
recorded in settings are not discovered or erased.

External project folders reached through links are preserved; the links inside
deleted directories are removed. Separate Python/R/agent installations, remote
hosts, WSL distributions, exported backups outside the listed paths, development
data (`.open-science-project`, `Open-Science-DEV`, or `OpenScience-DEV`), and the application installation
are preserved. This is a data reset, not an uninstall or a credential revocation
service: external provider accounts and separately installed CLI sign-ins remain.

Windows AppContainer, firewall, and ACL ownership records under
`%LOCALAPPDATA%\Aipoch\OpenScience\notebook-sandbox` are preserved. Their owner is
the app's uninstaller; deleting those records directly would lose the information
needed to release OS resources. Small shared cache-parent markers also remain.

## If reset stops

- **An application/runtime process is listed:** close it normally and retry. The
  tool never kills processes. All `wsl.exe` processes block reset because their
  relationship to Linux-side runtime work cannot be established reliably here.
  Uninspectable Electron/Node/Python/R/micromamba and native agent processes also
  block reset. The tool excludes its own observed launcher-shell ancestors.
- **Settings is corrupt or has recovery files:** review the actual data location
  first. Supply its full path explicitly, including the final `Open-Science` or legacy `OpenScience` folder:

  ```cmd
  reset-open-science.cmd -Preview -DataRoot "D:\Research\Open-Science"
  reset-open-science.cmd -DataRoot "D:\Research\Open-Science"
  ```

  `-DataRoot` replaces settings-based discovery; it still includes the default
  and legacy folders. For an installation that only used the default location,
  supply the actual `%USERPROFILE%\Open-Science` or legacy `%USERPROFILE%\OpenScience`. It does not recover corrupt settings or
  discover previously configured folders automatically.

- **Custom Electron profile:** the tool only includes the two standard profile directories.
  Profiles selected with `OPEN_SCIENCE_USER_DATA` or derived from a configuration override
  require manual review; it does not discover or delete arbitrary profiles.
- **Unsafe path or ownership failure:** nothing is deleted during plan discovery.
  Drive/profile/system roots, network paths, nonstandard custom folder names, and
  target/ancestor junctions are refused. Do not rename folders or rewrite cache
  ownership markers to bypass a refusal; ask for manual support.
- **Access denied, path too long, or locked file:** cleanup stops and returns exit
  code 1. Some earlier files may already be removed. Configuration is processed
  last to retain custom-path discovery when data deletion fails. Resolve the
  reported failure and rerun the tool; it accepts already-missing folders.

Exit code 0 means completion, preview, or cancellation; read the final message.
Process checks run before confirmation and again before each target is removed.
They cannot atomically prevent another app launch during deletion. Do not reopen
Open-Science or start background runtime work while reset is running.

## Maintainer validation

Run `npm test -- scripts/windows-data-reset.test.ts` from the repository root on
Windows. It uses disposable fixtures and tests PowerShell 5.1, process refusal,
confirmation, path/link boundaries, corrupt settings, locked files, and the CMD
launcher. The standalone PowerShell file includes the installer owner's cache
validation functions so users need only the two downloaded files. A portable
contract test requires those functions to remain identical to
`build/windows-runtime-cache-uninstall.ps1`.

There are no application schema changes or new durable states. Historical support
is limited to the legacy configuration-root data layout and known managed cache
identities; unknown custom layouts require manual review.
