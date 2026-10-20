import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '@aipoch/durable-files'
import type { CheckpointStorage } from '@aipoch/literature-discovery'
import { LITERATURE_OVERSIZED_REFERENCE } from '@aipoch/literature-library'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  acquireDataRootWriter,
  isMigrationPending,
  withDataRootWrite
} from '../storage/migration-state'

export const discoveryCheckpoints: CheckpointStorage = {
  read: (path, decode, maxBytes) => readDurableJsonFile(path, decode, {}, { maxBytes }),
  write: (path, contents) => writeDurableJsonFile(path, contents),
  recoverDirectory: (path, decode, maxBytes) =>
    recoverDurableJsonDirectory(path, decode, {}, { maxBytes }),
  recoveryBarrier: (message) => new DurableJsonRecoveryBarrierError(message)
}
export const discoveryJobOptions = {
  checkpoints: discoveryCheckpoints,
  admission: {
    acquireWriter: acquireDataRootWriter,
    isPending: isMigrationPending,
    withWrite: withDataRootWrite
  },
  oversizedError: (id: string) =>
    new ApplicationCommandError('command-failed', LITERATURE_OVERSIZED_REFERENCE + id)
}
