# Windows update failure notice regression

This opt-in test runs real NSIS installers through the same `/S --updated --force-run`
boundary as electron-updater's Restart action. It observes the native failure dialog,
installer exit code, and launchable version. There is no production test seam.

Run on a Windows desktop with a **non-elevated** token, the existing repository
dependencies, .NET Framework's `csc.exe`, and electron-builder's cached NSIS tools.
Do not run two copies concurrently: the fixture has one dedicated product GUID.
Portable Vitest runs skip these tests; a skip is not native certification.

From the repository/worktree root, using PowerShell:

```powershell
# Point these at your existing electron-builder cache directories.
$env:ELECTRON_BUILDER_NSIS_DIR = '<cached nsis directory>'
$env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = '<cached nsis-resources directory>'
$env:OPEN_SCIENCE_MAKENSIS = "$env:ELECTRON_BUILDER_NSIS_DIR/makensis.exe"
node scripts/fixtures/windows-update-notice/build.mjs .scratch/notice-fixture
$env:OPEN_SCIENCE_UPDATE_NOTICE_FIXTURE = (Get-Item .scratch/notice-fixture).FullName
node node_modules/vitest/vitest.mjs run scripts/windows-update-notice.test.ts --maxWorkers=1
```

Rebuild after any installer-hook change. The builder uses the released `v0.25.1`
hook for the previous installer and the working tree hook for the target installer;
the tag must exist locally. Tiny native payloads return 25 and 26 respectively.
Runtime cleanup scripts are successful stubs, so the fixture cannot manage real
application resources. Install/profile/temp paths live under the supplied fixture
directory; the product name and registry GUID are distinct from Open-Science.

The runner refuses an existing fixture registration or nonempty install directory.
For the permission scenario it changes only the fixture uninstaller's DACL, proves
write access is denied, then restores and verifies its exact original DACL in
`finally`. The lock scenario holds that same file with read-only sharing. Normal
completion and assertion failures uninstall the fixture. If the runner is forcibly
terminated, inspect the fixture registration and files before running again; do not
remove any real Open-Science installation or change its permissions.

| Scenario                           | Expected public behavior                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Access denied, interactive restart | Error 5 and administrator recovery notice; dismiss → exit 2, previous app launchable |
| File occupied, interactive restart | Error 32 and Retry/Cancel notice; Cancel → exit 2, previous app launchable           |
| File released before Retry         | Retry → exit 0, new app launchable                                                   |
| Access denied, unattended update   | No blocking notice; exit 2, previous app launchable                                  |
| File occupied, unattended update   | No blocking notice; exit 2, previous app launchable                                  |

Before the failure-notice change, the three interactive cases fail because the installer
exits 2 without displaying a notice, leaving the old app launchable. The unattended
cases already pass. This reproduces a sufficient cause of the reported silent
failure, not proof of a specific reporter's ACL or antivirus state.

This fixture covers the installer boundary, not Electron relaunch, all NSIS error
codes, full package contents, antivirus products, or elevated/manual recovery.

## Legacy per-machine elevation ordering

The additional `elevation` installer embeds the current hook and replaces only
`UAC_RunElevated` with `elevation-probe.nsh`. Real secure-desktop consent cannot be
driven unattended by this test. The replacement records the request and returns
Win32 cancellation (1223); the real NSIS initialization and cancellation handling
still run. No administrative rights are granted and no production seam is added.

The `denied-elevation` cases select all-users mode through the public `/allusers`
argument, with an actual protected fixture uninstaller. They require reaching UAC
before rejecting the file, preserving cancellation status, and keeping the old
executable launchable. The nested-data case also requires the original data to
remain in place at the moment of the request and after cancellation.
`denied-currentuser` verifies that `/currentuser` retains the access-denied notice
without requesting UAC. `writable` verifies a normal current-user upgrade succeeds.

On the pre-fix hook, `denied-elevation` fails with the actual error-5 notice and
installer exit 2 before any elevation request. After the fix it reaches the request
and preserves the simulated cancellation. This covers the same upstream decision
used for a registered legacy per-machine install; it does not create an HKLM
registration or certify real UAC approval, different-account credentials, or a
complete elevated upgrade. The `0.26.0` fixture directory is a version marker;
its hook always comes from the current working tree.

`denied-elevated-target` exercises the elevated preflight with both user and
machine registrations pointing to different directories. The fixture reports an
admin token to NSIS but keeps real OS write denial in place. Its `preInit` uses
Win32 `RegOverridePredefKey` to redirect HKLM only within the fixture process to
a dedicated HKCU test hive; it never writes the real machine registration. The
test requires the machine-target error notice and the original user executable
to remain launchable, proving target selection happens before either uninstall.
The temporary hive and machine-target file are removed in `finally`.
This covers branch behavior, not the security properties of an actual elevated
token. Both test prefixes are excluded from uninstaller generation/execution.
