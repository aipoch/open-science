import type { SessionPersistenceFlushResponse } from '../session-persistence-flush'

import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootSelection,
  DataRootValidationResult,
  DiscardMigratedCopyResult,
  MigrationOutcome,
  MigrationProgress,
  RevealAppStorageResult,
  StorageInfo,
  StorageStatus
} from '../storage'

import {
  callable,
  LOCAL,
  STORAGE_PARENT,
  type AcpListener,
  type RemoveListener,
  EVENT,
  STORAGE_ROOT
} from './definition'

export const contracts = {
  'storage.acceptMissingDataRoot': callable<() => Promise<void>>()('storage', [
    'storage:accept-missing-data-root',
    LOCAL
  ]),
  'storage.ackDataRootHandoffFlush': callable<
    (response: SessionPersistenceFlushResponse) => Promise<void>
  >()('storage', ['storage:ack-data-root-handoff-flush', LOCAL]),
  'storage.cancelMigrate': callable<() => Promise<void>>()('storage', [
    'storage:cancel-migrate',
    LOCAL
  ]),
  'storage.commitAndRelaunch': callable<(parent: string) => Promise<MigrationOutcome>>()(
    'storage',
    ['storage:commit-and-relaunch', LOCAL, STORAGE_PARENT]
  ),
  'storage.detectActive': callable<() => Promise<ActiveSessionInfo[]>>()('storage', [
    'storage:detect-active'
  ]),
  'storage.discardMigratedCopy': callable<(parent: string) => Promise<DiscardMigratedCopyResult>>()(
    'storage',
    ['storage:discard-migrated-copy', LOCAL, STORAGE_PARENT]
  ),
  'storage.dismissLegacyMovePrompt': callable<() => Promise<void>>()('storage', [
    'storage:dismiss-legacy-move-prompt'
  ]),
  'storage.getStatus': callable<() => Promise<StorageStatus>>()('storage', ['storage:get-status']),
  'storage.getInfo': callable<() => Promise<StorageInfo>>()('storage', ['storage:get-info']),
  'storage.inspectDataRoot': callable<(parent: string) => Promise<DataRootInspection>>()(
    'storage',
    ['storage:inspect-data-root', LOCAL, STORAGE_PARENT]
  ),
  'storage.migrate': callable<
    (parent: string, selection?: DataRootSelection) => Promise<MigrationOutcome>
  >()('storage', ['storage:migrate', LOCAL, STORAGE_PARENT]),
  'storage.onProgress': callable<(listener: AcpListener<MigrationProgress>) => RemoveListener>()(
    'storage',
    ['storage:migrate-progress', EVENT]
  ),
  'storage.pickDirectory': callable<() => Promise<string | null>>()('storage', [
    'storage:pick-directory',
    LOCAL
  ]),
  'storage.revealAppStorage': callable<() => Promise<RevealAppStorageResult>>()('storage', [
    'storage:reveal-app-storage',
    LOCAL
  ]),
  'storage.setDataRootAndRelaunch': callable<
    (
      parent: string,
      markOnboarding?: boolean,
      selection?: DataRootSelection
    ) => Promise<DataRootValidationResult>
  >()('storage', ['storage:set-data-root-and-relaunch', LOCAL, STORAGE_ROOT]),
  'storage.validateDataRoot': callable<(parent: string) => Promise<DataRootValidationResult>>()(
    'storage',
    ['storage:validate-data-root', LOCAL, STORAGE_PARENT]
  )
} as const
