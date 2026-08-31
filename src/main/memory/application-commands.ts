import {
  memoryApplicationCommandContracts,
  type CreateMemoryCategoryRequest,
  type CreateMemoryEntryRequest,
  type DeleteMemoryCategoryRequest,
  type DeleteMemoryEntryRequest,
  type MemorySnapshot,
  type SetMemoryEnabledRequest,
  type UpdateMemoryCategoryRequest,
  type UpdateMemoryEntryRequest
} from '../../shared/memory'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommand,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

type MemoryCommandOwner = Readonly<{
  snapshot(): Promise<MemorySnapshot>
  setEnabled(request: SetMemoryEnabledRequest): Promise<MemorySnapshot>
  createCategory(request: CreateMemoryCategoryRequest): Promise<MemorySnapshot>
  updateCategory(request: UpdateMemoryCategoryRequest): Promise<MemorySnapshot>
  deleteCategory(request: DeleteMemoryCategoryRequest): Promise<MemorySnapshot>
  createEntry(request: CreateMemoryEntryRequest): Promise<MemorySnapshot>
  updateEntry(request: UpdateMemoryEntryRequest): Promise<MemorySnapshot>
  deleteEntry(request: DeleteMemoryEntryRequest): Promise<MemorySnapshot>
  clearAll(): Promise<MemorySnapshot>
}>

const command = <Name extends string, Args extends readonly unknown[]>(
  name: Name,
  contract: Parameters<typeof defineApplicationCommand<Name, Args, MemorySnapshot>>[1]
): ApplicationCommand<Name, Args, MemorySnapshot> =>
  defineApplicationCommand<Name, Args, MemorySnapshot>(name, contract)

const memoryApplicationCommands = Object.freeze({
  snapshot: command<'memory:snapshot', readonly []>(
    'memory:snapshot',
    memoryApplicationCommandContracts.snapshot
  ),
  setEnabled: command<'memory:set-enabled', readonly [SetMemoryEnabledRequest]>(
    'memory:set-enabled',
    memoryApplicationCommandContracts.setEnabled
  ),
  createCategory: command<'memory:create-category', readonly [CreateMemoryCategoryRequest]>(
    'memory:create-category',
    memoryApplicationCommandContracts.createCategory
  ),
  updateCategory: command<'memory:update-category', readonly [UpdateMemoryCategoryRequest]>(
    'memory:update-category',
    memoryApplicationCommandContracts.updateCategory
  ),
  deleteCategory: command<'memory:delete-category', readonly [DeleteMemoryCategoryRequest]>(
    'memory:delete-category',
    memoryApplicationCommandContracts.deleteCategory
  ),
  createEntry: command<'memory:create-entry', readonly [CreateMemoryEntryRequest]>(
    'memory:create-entry',
    memoryApplicationCommandContracts.createEntry
  ),
  updateEntry: command<'memory:update-entry', readonly [UpdateMemoryEntryRequest]>(
    'memory:update-entry',
    memoryApplicationCommandContracts.updateEntry
  ),
  deleteEntry: command<'memory:delete-entry', readonly [DeleteMemoryEntryRequest]>(
    'memory:delete-entry',
    memoryApplicationCommandContracts.deleteEntry
  ),
  clearAll: command<'memory:clear-all', readonly []>(
    'memory:clear-all',
    memoryApplicationCommandContracts.clearAll
  )
})

const memoryApplicationCommandGroup = defineApplicationCommandGroup('memory', [
  memoryApplicationCommands.clearAll,
  memoryApplicationCommands.createCategory,
  memoryApplicationCommands.createEntry,
  memoryApplicationCommands.deleteCategory,
  memoryApplicationCommands.deleteEntry,
  memoryApplicationCommands.setEnabled,
  memoryApplicationCommands.snapshot,
  memoryApplicationCommands.updateCategory,
  memoryApplicationCommands.updateEntry
] as const)

const registerMemoryApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: MemoryCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(memoryApplicationCommandGroup, {
      'memory:snapshot': () => owner.snapshot(),
      'memory:set-enabled': ({ args }) => owner.setEnabled(args[0]),
      'memory:create-category': ({ args }) => owner.createCategory(args[0]),
      'memory:update-category': ({ args }) => owner.updateCategory(args[0]),
      'memory:delete-category': ({ args }) => owner.deleteCategory(args[0]),
      'memory:create-entry': ({ args }) => owner.createEntry(args[0]),
      'memory:update-entry': ({ args }) => owner.updateEntry(args[0]),
      'memory:delete-entry': ({ args }) => owner.deleteEntry(args[0]),
      'memory:clear-all': () => owner.clearAll()
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  memoryApplicationCommandGroup,
  memoryApplicationCommands,
  registerMemoryApplicationCommands
}
export type { MemoryCommandOwner }
