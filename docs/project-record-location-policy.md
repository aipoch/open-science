# Project research record location policy

New custom-folder projects keep durable research records in `.open-science/`. Their creation,
relocation and execution entry points must call `assertProjectRecordLocation` after ordinary
folder/capability validation. Existing projects retain their storage contract and advisory location
warnings; this policy does not migrate them.

Known cloud, network and removable locations are rejected. Missing positive internal-volume
evidence is rejected through the existing localized folder-unavailable notice. Diagnostics include
the classification; no new file-write sandbox is introduced.

## Platform evidence

- macOS: `/sbin/mount` selects the containing mount; `diskutil info -plist` must report
  `Internal=true`, `Ejectable=false`, and `RemovableMedia=false`. Native validation on this
  development Mac (2026-11-16) successfully admitted the repository on the internal APFS volume.
  `diskutil` needs the mount point: it does not accept arbitrary child directory paths.
- Windows: existing warning probes use DriveInfo/Get-Disk. The strict policy resolves the actual
  volume with `Get-Volume -FilePath`, including volume mount points, then requires a Fixed volume
  on an ATA, SATA or NVMe disk. USB/SD/MMC/1394 are rejected. Unknown, virtual or unmapped buses
  are rejected. These cases have fixture coverage; no native Windows run was performed here.
- Linux: mountinfo selects the longest containing mount; ordinary local filesystem types require
  an ATA/NVMe sysfs device with a non-removable flag. Known USB/Thunderbolt ancestry is rejected.
  Network filesystems are rejected by the shared warning probe. Device mapper, virtual disks,
  containers and WSL locations without positive physical device evidence are rejected as unknown.
  These cases have fixture coverage; no native Linux/WSL run was performed here.

Physical attachment metadata reflects what the OS exposes. An external device that the OS reports
as indistinguishable from an internal SATA/NVMe disk cannot be universally identified, particularly
on Linux/Windows. The policy is deliberately conservative for unknown bus types.

## Cloud detection boundary

The existing shared probe recognizes OneDrive environment roots, macOS CloudStorage/Mobile
Documents roots, and Dropbox account roots from provider configuration. Roots are canonicalized
so directory aliases do not bypass those checks. Arbitrary provider roots without configuration
or metadata cannot be discovered universally. An accepted volume is evidence about local storage,
not proof that an unknown third-party application is not syncing that directory.

## Internal record isolation

The reserved `.open-science` path component (including case variants) is excluded from ordinary
Project browsing, descendant search, file mentions, preview and reference resolution. Canonical
path checks reject aliases into it. Working-file snapshots, declared-path evidence and watcher
signals exclude it, and app-mediated staging refuses it. Input provenance ignores these records.
Notebook tool instructions direct models to dedicated Notebook/Artifact operations for records.
Those owners continue to access their storage directly. Native code can still write directly to
files under the user's normal execution permissions; isolation is not a general write interceptor.

Windows command contract references: [Get-Volume](https://learn.microsoft.com/en-us/powershell/module/storage/get-volume?view=windowsserver2025-ps)
(`-FilePath`) and [Get-Partition](https://learn.microsoft.com/en-us/powershell/module/storage/get-partition?view=windowsserver2025-ps)
(volume association). These establish the documented API shape, not native execution evidence.

## Restoring Session discovery after reopening

`restoreProjectRecordSessions` is an explicit-reopen helper. The caller first revives the Project
and its record route, then supplies the live projection-enabled Session repository and Notebook
repository. It creates missing Session shells with the original IDs so the existing Notebook UI
can browse their durable runs. Shells receive fresh managed workspaces, an empty conversation,
and conservative preferences. They have no imported-package origin or provider continuation.

Existing Session JSON is preserved; unreadable JSON blocks reconstruction instead of being replaced.
Run documents and user scripts are read through the Notebook repository and remain unchanged.
This restores research discoverability, not the former chat/provider history or friendly frame
labels. Ordinary restarts must not invoke this explicit-reopen operation.

## Persistent layout and authority

Only newly created custom-folder Projects use this layout. The `.open-science/project.json`
manifest owns the Project identity and format version. Notebook documents and execution evidence,
Artifact versions, message snapshots and provenance metadata live beneath that directory.
`artifact-index.json` is the durable research metadata checkpoint; application SQLite rows are
rebuildable indexes. Managed `project-record-routes/<projectId>.json` files locate these records and
track explicit detach/reopen recovery; application data-root migration carries these pointers.

Provider workspaces/history, Notebook execution projections, long-lived turn staging and original
file recovery backups stay in application storage. Final Artifact publication may prepare an atomic
same-volume temporary file beside its destination; this is not a second authority or background
synchronization. Input provenance metadata does not make externally referenced source bytes
portable: absent sources remain absent rather than being fabricated during reindexing.

Relocation validates the same manifest identity and updates the route without rewriting user code.
A missing/corrupt record directory never silently falls back to empty managed research history.
Deleting a Project records its deletion intent before detaching its route and preserves the folder.
Selecting that folder through New project restores its identity and research indexes; interrupted
Session discovery is retried on subsequent Project access. This does not restore deleted provider
conversation history.

Research writes checkpoint the affected Project before acknowledging the SQLite commit. A failed
SQLite commit is reconciled from that checkpoint on subsequent access. A transaction that attempts
to mutate multiple active custom-folder Project authorities is rejected before writing either
checkpoint; no distributed multi-directory commit protocol was introduced. Normal publication,
package import and fork write one target Project. Foreign source facts may be retained for
provenance, but their mutable heads are not overwritten when another Project reopens.
