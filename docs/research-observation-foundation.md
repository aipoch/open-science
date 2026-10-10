# Observation and recording foundations

This layer adds Main-owned observation, project-service viewing and recording primitives on top of
managed research execution. The desktop/browser Replay integration is a separate consumer. This
foundation alone does not install a viewer page, add a Replay button or enable an unsupported
execution option in the application composition.

## Ownership

- The existing managed execution service admits the environment and command and owns its outcome.
- `RunObservationOwner` reads a specific admitted execution and projects bounded, sanitized history.
  Its viewer registry scopes access to the caller, exact execution and current lifetime.
- `ManagedRuntimeViews` exposes only a service registered by that execution. It verifies the original
  socket and generation; opening a view never starts or repeats a command.
- `RunObservationRecorder` saves bounded observation history independently of viewer lifetime.
  `ManagedRunObservationCoordinator` binds publication to the original admitted turn and exact
  Artifact write receipt, including recovery after interruption.
- `createManagedObservationPort` supplies the execution owner's optional evidence port. Opaque
  handles resolve through the issuing adapter's private identity map; public request data cannot
  install capture authority. `createManagedRecordingStatusReader` keeps status reads outside the
  execution owner and verifies the exact execution and published Version before reporting a saved
  archive.
- Project image/state recording and browser pixel recording are separate evidence sinks. They
  consume already authorized sources and cannot launch an experiment. Their detailed contracts are
  in `src/main/project-recordings/README.md` and `src/main/browser-recordings/README.md`.

Main composition must install these owners, the optional observation adapter and their lifecycle
cleanup together. The HTTP host and external ports are adapters; they are not an alternate Session,
process owner or permission store. A later UI integration supplies packaged assets and registers
only its exact embedded frames with the Main navigation authority.

## Recorded data and `.science`

Recordings are ordinary immutable Artifacts: bounded indexes, captured images or independently
finalized WebM segments, and optional author-declared state/event records. This does not change the
`.science` manifest, archive version or import/export rules.

Receiving readers resolve media through an exact native publication receipt or retained import
receipt and the receiving Project/Session's immutable versions. Sender version IDs, filenames,
URLs and paths are not authority. Missing, altered, ambiguous or omitted media remains unavailable;
reading it never launches the source project or fetches the author's machine.

The Session package reader exposes a bounded source-Version mapping for this purpose. It verifies
the requested receiving Artifact's identity and original checksum/size against the retained import
receipt before returning any mapping. Original imported Sessions remain read-only.

## Validation boundaries

Colocated tests cover observation identity and grants, bounded capture, publication recovery,
recorded-media resolution and package round trips. Opt-in Electron integration tests exercise the
actual compositor, local service framing and visible-surface capture using temporary applications.
They do not access an installed application's data or start a scientific trial.

Browser capture currently targets the local desktop and produces video without audio. Arbitrary
remote desktop capture, DOM reconstruction and MP4 export are not provided by this layer. A saved
recording is evidence of observed execution; its existence alone does not establish scientific
reproduction.

## Standalone backend and native capture

The Node backend owns observation, permission leases, HTTP viewers and immutable Artifact writes.
`observation-desktop/bridge.ts` injects an optional private desktop capability; it does not import
Electron. The desktop installs `observation-desktop/electron.ts` using the existing transport's
`documentFor` resolver. A document UUID is never a numeric window ID outside that trusted adapter.
Frame grants are acknowledged by the native navigation registry before a viewer URL or redirect is
returned. Reload, document replacement and transport loss revoke native capture and frame grants.
Local SDK viewers retain their own backend lease and do not require a connected desktop.

The compositor, crop/masking and WebM encoder stay in Electron. The bridge transports only complete
segments (at most 8 MiB each), bounded metadata batches and explicit acknowledgements. It does not
send raw frames through the command transport. The next segment waits for the backend Artifact
sink to accept the previous one. Stop drains admitted evidence; release, stale documents, stalled
polling and disconnect dispose native resources without granting a replacement document access.
Without an attached desktop, screenshots/browser recording are unavailable; existing observation,
project-export recording and recorded evidence readers remain usable. Closing capture does not
cancel the backend-owned experiment. The Replay layer installs the actual application composition.
