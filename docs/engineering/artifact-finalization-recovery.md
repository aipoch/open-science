# Artifact finalization concurrency repair

## Diagnosis and boundaries

The supplied 0.30.0 run029 bundle records a rejected Session write (expected revision 276,
actual 278). The run030 bundle records a finalized Artifact owner outside its bound Branch,
with both a streamed Message and a separately identified aggregated completion Message.
These snapshots establish the failures; they do not identify every historical interleaving.

A local DEV reproduction with Task API execution and an open desktop observer reproduced
both duplicate answers and a Session revision conflict (25 versus 27). Main created a random
completion Message ID while the renderer derived an ID from the provider stream. The same
provider event IDs consequently appeared under two owners.

The ordered renderer saver also promoted a queued snapshot to an acknowledged revision
without merging the acknowledged graph. That defeated the meaning of the optimistic-lock
revision: old topology could be submitted as if it came from the new revision. The finalized
binding validator then correctly rejected incompatible ownership.

The revision check is necessary: it prevents silent lost writes. A retry must reload and
merge known changes, not replace the expected revision on unchanged stale data. The Branch
binding check is likewise necessary and remains enabled.

## Changes

- Main and renderer share deterministic stream Message identity. Task completion preserves
  separate streams, ignores replayed events, and merges an existing owner rather than adding
  an aggregate duplicate. Both flat and graph projections receive the terminal update.
- The ordered saver retains the source snapshot alongside the durable receipt, rebases queued
  changes onto that receipt, and refuses to fabricate a merge base after its body is released.
  The existing bounded conflict recovery uses the same shared three-way merge.
- Settled save receipts update the renderer transcript when the source is still current.
- Task terminal persistence upserts existing Artifact descriptors and records the exact settled
  run identity. A stale observer cannot reopen that attempt; a later attempt remains allowed.
- Both initial and already-attached Artifact event paths can attempt one proof-checked native
  publication recovery. All requested immutable Versions must be returned as published, and
  durable Session authority must reload successfully. The renderer then adopts the returned
  publication descriptors. This does not rerun model or Notebook work. Invalid proofs and
  incompatible ownership still fail closed.
- Publication readiness remains a Main-derived runtime fact, not a persisted boolean that a
  stale Session snapshot can assert.

## Validation

Focused tests cover queued stale snapshots, released merge bases, same-ID terminal staging,
multiple provider streams, duplicate event delivery, existing descriptor updates, committed-run
resurrection versus a fresh run, complete/incomplete publication recovery, and both attachment
entry paths. Existing provenance tests continue to check invalid ownership.

Isolated worktree DEV test (2026-09-16): Task API started a Plan-first task while the desktop
observed the same Session. The Plan was approved in the native UI. Notebook computed the mean
of [2,4,6], corrected its own initial 4.0 formatting, and published mean.txt. The preview opened
and displayed 4; stored bytes were exactly `4\n`. The final answer occurred once, no provider
event belonged to multiple Messages, Task was completed, Session was idle, and activeRun was
absent. Task run: 3a4f67be-36d8-491d-b697-dd6de7a9d25b.

This is a deterministic boundary-test and small live reproduction, not a replay of the entire
historical Windows NHANES analysis. Existing invalid historical bindings are not silently
rewritten by this change. Reviewer admission fixes from earlier work are not changed here.
