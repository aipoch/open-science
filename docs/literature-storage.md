# Literature deletion and storage cleanup

Moving a reference to Trash retains its metadata and attached files. Restore it before editing,
previewing attachments, or exporting it. Permanent deletion removes the selected reference and
its metadata; this cannot be undone.

## Attached files

After the catalog transaction commits, Open Science attempts to remove the associated managed
content. A file still referenced by another reference, upload, artifact, or Inbox PDF is retained.
External source files outside managed storage are not removed by this cleanup.

If file removal fails, the reference stays deleted. The interface reports that some files await
cleanup; this is not evidence of a rolled-back deletion. Startup recovery can retry unreferenced
content whose Blob creation time is more than one hour old. This cutoff is based on content
creation time, not deletion time. Recovery runs when startup recovery executes and depends on
file access; it does not promise cleanup one hour after deletion or at the next start.

If only the subsequent view refresh fails, the interface retains the committed deletion result.
Its Retry action reloads data rather than submitting another permanent deletion.

## Derived search indexes and historical outputs

Extracted search text is stored in a separate, rebuildable SQLite index. Deleting the original
reference and its last managed file does not immediately purge that index. Index maintenance
removes documents idle for more than one day, runs when retention maintenance starts, and scans
roughly every three hours while running. Access updates and application runtime affect when
cleanup occurs. Normal document reads still validate the source's authority first.

Historical outputs and snapshots are separate records; deleting a reference does not erase those
outputs. File removal and logical SQLite deletion are not a secure-erasure guarantee.

Dismissed Inbox candidates can be viewed and restored from Dismissed. Their attached PDFs remain
referenced and are therefore retained. Dismiss is not a permanent file-deletion operation.
