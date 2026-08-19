import {
  tagApplicationCommandContracts,
  type CreateTagRequest,
  type DeleteTagRequest,
  type ReorderTagsRequest,
  type SetTagAssignmentRequest,
  type TagSnapshot,
  type UpdateTagRequest
} from '../../shared/tags'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

type TagCommandOwner = Readonly<{
  snapshot(): Promise<TagSnapshot>
  create(request: CreateTagRequest): Promise<TagSnapshot>
  update(request: UpdateTagRequest): Promise<TagSnapshot>
  delete(request: DeleteTagRequest): Promise<TagSnapshot>
  reorder(request: ReorderTagsRequest): Promise<TagSnapshot>
  setAssignment(request: SetTagAssignmentRequest): Promise<TagSnapshot>
}>

const tagApplicationCommands = Object.freeze({
  snapshot: defineApplicationCommand<'tags:snapshot', readonly [], TagSnapshot>(
    'tags:snapshot',
    tagApplicationCommandContracts.snapshot
  ),
  create: defineApplicationCommand<'tags:create', readonly [CreateTagRequest], TagSnapshot>(
    'tags:create',
    tagApplicationCommandContracts.create
  ),
  update: defineApplicationCommand<'tags:update', readonly [UpdateTagRequest], TagSnapshot>(
    'tags:update',
    tagApplicationCommandContracts.update
  ),
  delete: defineApplicationCommand<'tags:delete', readonly [DeleteTagRequest], TagSnapshot>(
    'tags:delete',
    tagApplicationCommandContracts.delete
  ),
  reorder: defineApplicationCommand<'tags:reorder', readonly [ReorderTagsRequest], TagSnapshot>(
    'tags:reorder',
    tagApplicationCommandContracts.reorder
  ),
  setAssignment: defineApplicationCommand<
    'tags:set-assignment',
    readonly [SetTagAssignmentRequest],
    TagSnapshot
  >('tags:set-assignment', tagApplicationCommandContracts.setAssignment)
})

const tagApplicationCommandGroup = defineApplicationCommandGroup('tags', [
  tagApplicationCommands.create,
  tagApplicationCommands.delete,
  tagApplicationCommands.reorder,
  tagApplicationCommands.setAssignment,
  tagApplicationCommands.snapshot,
  tagApplicationCommands.update
] as const)

const registerTagApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: TagCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(tagApplicationCommandGroup, {
      'tags:snapshot': () => owner.snapshot(),
      'tags:create': ({ args }) => owner.create(args[0]),
      'tags:update': ({ args }) => owner.update(args[0]),
      'tags:delete': ({ args }) => owner.delete(args[0]),
      'tags:reorder': ({ args }) => owner.reorder(args[0]),
      'tags:set-assignment': ({ args }) => owner.setAssignment(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { registerTagApplicationCommands, tagApplicationCommandGroup, tagApplicationCommands }
export type { TagCommandOwner }
