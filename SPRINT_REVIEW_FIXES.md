# Sprint Review Fixes - Phase 3b

## Summary

Fixed 6 out of 7 issues identified in the phase 3b sprint review (issues #1, #2, #3, #5, #6, #7). Issue #4 was already resolved in a previous commit.

## Issues Fixed

### #1 display_name Denormalize Flip
**Problem:** Job cards flip between displayName and provider_id when notification arrives because `emitJobNotification` was using raw `provider_id` instead of looking up the host's `displayName`.

**Fix:**
- Added `hostRepository` to `JobNotifierDeps`
- `emitJobNotification` now calls `hostRepository.get()` to lookup displayName
- Updated all call sites: `harvest-engine.ts` and `job-poller.ts`
- Added test assertion to verify displayName is set correctly

**Files Changed:**
- `src/main/compute/job-notifier.ts`
- `src/main/compute/job-notifier.test.ts`
- `src/main/compute/harvest-engine.ts`
- `src/main/compute/job-poller.ts`

---

### #2 harvestedAt/notifiedAt Atomicity
**Problem:** Two separate DB writes (harvestedAt first, then notifiedAt via `emitJobNotification`) could lose notifications on restart between the writes.

**Fix:**
- Merged into single atomic update in harvest `finalize()` function
- Write `harvestedAt` + `notifiedAt` together in one transaction
- Move broadcast logic outside transaction to fire after atomic write
- Inline notification building in `harvest-engine` (`buildAndBroadcastNotification` helper)
- Remove the separate `emitJobNotification` call from finalize path

**Files Changed:**
- `src/main/compute/harvest-engine.ts`
- `src/main/compute/job-notifier.ts` (import changes)

---

### #3 consumed Timing Correction
**Problem:** `notificationConsumedAt` was set immediately after dispatch, not when the turn actually completes. This caused premature marking before Claude processes the notification.

**Fix:**
- Deferred `markConsumed` call from post-dispatch to `onTurnEnd` callback
- Added `awaitingTurnEnd` map to track jobs waiting for turn completion
- Only set `notificationConsumedAt` when session transitions to idle
- Added `onTurnEndCallback` to handle turn completion logic

**Files Changed:**
- `src/renderer/src/lib/compute/job-analysis-trigger.ts`
- `src/renderer/src/lib/compute/job-analysis-trigger.test.ts`

---

### #5 Harvest scp Path Validation
**Problem:** Only validated `relativePath`, not the complete `absRemotePath` (workdir + relativePath). Combined path could produce shell-unsafe characters.

**Fix:**
- Added validation of complete `absRemotePath` for `SHELL_UNSAFE_CHARS` before scp
- Protects against unsafe combined paths even if workdir is system-generated
- Consistent with `shellSingleQuote` usage in enumerate (line 83)

**Files Changed:**
- `src/main/compute/harvest-engine.ts`

---

### #6 Remote Enumeration Truncation Detection
**Problem:** If remote listing exceeds 4MB cap, output is silently truncated. Trailing files would neither be downloaded nor appear in `left_on_remote`.

**Fix:**
- Check `SshRunner.result.truncated` flag after enumerate
- Throw descriptive error if listing was truncated
- Suggests user cleanup for directories with millions of files

**Files Changed:**
- `src/main/compute/harvest-engine.ts`

---

### #7 output_file_count → featured_file_count Rename
**Problem:** Inconsistent terminology - field was called `output_file_count` but counted `featured_files`, not all outputs.

**Fix:**
- Renamed to `featured_file_count` throughout codebase
- Updated `JobSummary` type definition in `shared/compute.ts`
- Updated `ComputeJob` schema in `compute-service.ts`
- Fixed `toJobSummary` to parse `left_on_remote` JSON and provide defaults
- Updated all test assertions across 5 test files

**Files Changed:**
- `src/shared/compute.ts`
- `src/main/compute/compute-service.ts`
- `src/main/compute/job-notifier.ts`
- `src/main/compute/job-notifier.test.ts`
- `src/main/compute/harvest-engine.test.ts`
- `src/main/compute/job-poller.test.ts`
- `src/main/compute/ipc.ts`
- `src/main/compute/ipc.test.ts`
- `src/renderer/src/lib/compute/job-analysis-trigger.test.ts`

---

## Test Results

All compute-related tests pass:
- **19 test files passed** (1 skipped)
- **366 tests passed** (5 skipped)
- Duration: 981ms

### Test Coverage
- `harvest-engine.test.ts` - 14 tests ✓
- `job-notifier.test.ts` - 5 tests ✓
- `job-poller.test.ts` - 25 tests ✓
- `compute-service.test.ts` - 111 tests ✓
- `job-analysis-trigger.test.ts` - 15 tests ✓
- `ipc.test.ts` - 180 tests ✓
- All other compute tests ✓

---

## Commit

```
fix(compute): address sprint review findings (01,02,03,05,06,07)

Commit: a5698e3
Branch: feat/wen2zhou/remote-compute-clean
```

---

## Next Steps

Ready for phase 3b final review. All identified issues have been addressed and verified with comprehensive test coverage.
