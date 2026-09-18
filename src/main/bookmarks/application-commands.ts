import {
  bookmarkApplicationCommandContracts,
  type Bookmark,
  type BookmarkListResult,
  type BookmarkPdfSourceResult,
  type CreateBookmarkRequest,
  type DeleteBookmarkRequest,
  type DeleteBookmarkResult,
  type ListBookmarksRequest,
  type ResolvePdfBookmarkSourceRequest,
  type UpdateBookmarkNoteRequest
} from '../../shared/bookmarks'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

type BookmarkCommandOwner = Readonly<{
  list(request: ListBookmarksRequest): Promise<BookmarkListResult>
  create(request: CreateBookmarkRequest): Promise<Bookmark>
  updateNote(request: UpdateBookmarkNoteRequest): Promise<Bookmark>
  delete(request: DeleteBookmarkRequest): Promise<DeleteBookmarkResult>
  resolvePdfSource(request: ResolvePdfBookmarkSourceRequest): Promise<BookmarkPdfSourceResult>
}>

const bookmarkApplicationCommands = Object.freeze({
  list: defineApplicationCommand<
    'bookmarks:list',
    readonly [ListBookmarksRequest],
    BookmarkListResult
  >('bookmarks:list', bookmarkApplicationCommandContracts.list),
  create: defineApplicationCommand<'bookmarks:create', readonly [CreateBookmarkRequest], Bookmark>(
    'bookmarks:create',
    bookmarkApplicationCommandContracts.create
  ),
  updateNote: defineApplicationCommand<
    'bookmarks:update-note',
    readonly [UpdateBookmarkNoteRequest],
    Bookmark
  >('bookmarks:update-note', bookmarkApplicationCommandContracts.updateNote),
  delete: defineApplicationCommand<
    'bookmarks:delete',
    readonly [DeleteBookmarkRequest],
    DeleteBookmarkResult
  >('bookmarks:delete', bookmarkApplicationCommandContracts.delete),
  resolvePdfSource: defineApplicationCommand<
    'bookmarks:resolve-pdf-source',
    readonly [ResolvePdfBookmarkSourceRequest],
    BookmarkPdfSourceResult
  >('bookmarks:resolve-pdf-source', bookmarkApplicationCommandContracts.resolvePdfSource)
})

const bookmarkApplicationCommandGroup = defineApplicationCommandGroup('bookmarks', [
  bookmarkApplicationCommands.create,
  bookmarkApplicationCommands.delete,
  bookmarkApplicationCommands.list,
  bookmarkApplicationCommands.resolvePdfSource,
  bookmarkApplicationCommands.updateNote
] as const)

const registerBookmarkApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: BookmarkCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(bookmarkApplicationCommandGroup, {
      'bookmarks:list': ({ args }) => owner.list(args[0]),
      'bookmarks:create': ({ args }) => owner.create(args[0]),
      'bookmarks:update-note': ({ args }) => owner.updateNote(args[0]),
      'bookmarks:delete': ({ args }) => owner.delete(args[0]),
      'bookmarks:resolve-pdf-source': ({ args }) => owner.resolvePdfSource(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  bookmarkApplicationCommandGroup,
  bookmarkApplicationCommands,
  registerBookmarkApplicationCommands
}
export type { BookmarkCommandOwner }
