import { ipcMainHandle } from '../ipc-handler-registry'
import {
  createStorageCommandOwner,
  type StorageCommandOwner,
  type StorageCommandOwnerDeps
} from './command-owner'

type StorageIpcDeps = StorageCommandOwnerDeps

const registerStorageIpcHandlers = (
  deps: StorageIpcDeps,
  owner: StorageCommandOwner = createStorageCommandOwner(deps)
): void => {
  ipcMainHandle('storage:accept-missing-data-root', () => owner.acceptMissingDataRoot())
  ipcMainHandle('storage:get-status', () => owner.getStatus())
  ipcMainHandle('storage:get-info', () => owner.getInfo())
  ipcMainHandle('storage:reveal-app-storage', () => owner.revealAppStorage())
  ipcMainHandle('storage:dismiss-legacy-move-prompt', () => owner.dismissLegacyMovePrompt())
  ipcMainHandle('storage:detect-active', () => owner.detectActive())
  ipcMainHandle('storage:pick-directory', () => owner.pickDirectory())
  ipcMainHandle('storage:migrate', (_event, request) => owner.migrate(request))
  ipcMainHandle('storage:cancel-migrate', () => owner.cancelMigrate())
  ipcMainHandle('storage:discard-migrated-copy', (_event, request) =>
    owner.discardMigratedCopy(request)
  )
  ipcMainHandle('storage:commit-and-relaunch', (_event, request) =>
    owner.commitAndRelaunch(request)
  )
  ipcMainHandle('storage:validate-data-root', (_event, request) => owner.validateDataRoot(request))
  ipcMainHandle('storage:inspect-data-root', (_event, request) => owner.inspectDataRoot(request))
  ipcMainHandle('storage:set-data-root-and-relaunch', (_event, request) =>
    owner.setDataRootAndRelaunch(request)
  )
}

export { registerStorageIpcHandlers }
export type { StorageIpcDeps }
