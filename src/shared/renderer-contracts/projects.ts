import type {
  CancelPromptOptimizationRequest,
  OptimizePromptRequest,
  OptimizePromptResult,
  OptimizationEvent
} from '../prompt-optimization'
import type {
  ScheduleCreateRequest,
  ScheduleHistoryRequest,
  ScheduleRun,
  ScheduleListRequest,
  ScheduleEditRequest,
  ScheduleDeleteRequest,
  ScheduleView,
  ScheduleSummary
} from '../session-schedules'
// Ordered fragments keep the public registration order when capabilities interleave.
import type { ProjectDeletedEvent } from '../lifecycle-events'

import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  Project,
  ProjectDeletionCleanup,
  ProjectDeletionOutcome,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../projects'

import type {
  CreateTagRequest,
  DeleteTagRequest,
  ReorderTagsRequest,
  SetTagAssignmentRequest,
  TagSnapshot,
  TagsChangedEvent,
  UpdateTagRequest
} from '../tags'

import type {
  Bookmark,
  BookmarkListResult,
  BookmarkPdfSourceResult,
  ResolvePdfBookmarkSourceRequest,
  CreateBookmarkRequest,
  DeleteBookmarkRequest,
  DeleteBookmarkResult,
  ListBookmarksRequest,
  UpdateBookmarkNoteRequest
} from '../bookmarks'

import {
  callable,
  WEB,
  RUNTIME_VALIDATED,
  type AcpListener,
  type RemoveListener,
  EVENT
} from './definition'

export const projectsCreateContracts = {
  'projects.optimizePrompt': callable<
    (request: OptimizePromptRequest) => Promise<OptimizePromptResult>
  >()('projects', ['projects:optimize-prompt', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'projects.cancelPromptOptimization': callable<
    (request: CancelPromptOptimizationRequest) => Promise<void>
  >()('projects', [
    'projects:cancel-prompt-optimization',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.recordOptimizationEvent': callable<(event: OptimizationEvent) => Promise<void>>()(
    'projects',
    ['projects:record-optimization-event', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'projects.create': callable<(request: CreateProjectRequest) => Promise<Project>>()('projects', [
    'projects:create',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.delete': callable<(request: DeleteProjectRequest) => Promise<ProjectDeletionOutcome>>()(
    'projects',
    ['projects:delete', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'projects.get': callable<(id: string) => Promise<Project | null>>()('projects', [
    'projects:get',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.list': callable<() => Promise<Project[]>>()('projects', [
    'projects:list',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.listDeletionCleanup': callable<() => Promise<ProjectDeletionCleanup[]>>()('projects', [
    'projects:list-deletion-cleanup',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.onCreated': callable<(listener: AcpListener<Project>) => RemoveListener>()('projects', [
    'project:created',
    EVENT
  ]),
  'projects.onDeleted': callable<(listener: AcpListener<ProjectDeletedEvent>) => RemoveListener>()(
    'projects',
    ['project:deleted', EVENT]
  ),
  'projects.onDeletionCleanupChanged': callable<
    (listener: AcpListener<undefined>) => RemoveListener
  >()('projects', ['project:deletion-cleanup-changed', EVENT]),
  'projects.onUpdated': callable<(listener: AcpListener<Project>) => RemoveListener>()('projects', [
    'project:updated',
    EVENT
  ]),
  'projects.update': callable<(request: UpdateProjectRequest) => Promise<Project>>()('projects', [
    'projects:update',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.retryDeletionCleanup': callable<() => Promise<void>>()('projects', [
    'projects:retry-deletion-cleanup',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'projects.updateArchive': callable<(request: UpdateProjectArchiveRequest) => Promise<Project>>()(
    'projects',
    ['projects:update-archive', WEB, undefined, undefined, RUNTIME_VALIDATED]
  )
} as const

export const bookmarksResolvePdfSourceContracts = {
  'bookmarks.resolvePdfSource': callable<
    (request: ResolvePdfBookmarkSourceRequest) => Promise<BookmarkPdfSourceResult>
  >()('bookmarks', ['bookmarks:resolve-pdf-source', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'bookmarks.list': callable<(request: ListBookmarksRequest) => Promise<BookmarkListResult>>()(
    'bookmarks',
    ['bookmarks:list', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'bookmarks.create': callable<(request: CreateBookmarkRequest) => Promise<Bookmark>>()(
    'bookmarks',
    ['bookmarks:create', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'bookmarks.updateNote': callable<(request: UpdateBookmarkNoteRequest) => Promise<Bookmark>>()(
    'bookmarks',
    ['bookmarks:update-note', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'bookmarks.delete': callable<(request: DeleteBookmarkRequest) => Promise<DeleteBookmarkResult>>()(
    'bookmarks',
    ['bookmarks:delete', WEB, undefined, undefined, RUNTIME_VALIDATED]
  )
} as const

export const tagsCreateContracts = {
  'tags.create': callable<(request: CreateTagRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:create',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.delete': callable<(request: DeleteTagRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:delete',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.onChanged': callable<(listener: AcpListener<TagsChangedEvent>) => RemoveListener>()(
    'tags',
    ['tags:changed', EVENT]
  ),
  'tags.reorder': callable<(request: ReorderTagsRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:reorder',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.setAssignment': callable<(request: SetTagAssignmentRequest) => Promise<TagSnapshot>>()(
    'tags',
    ['tags:set-assignment', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'tags.snapshot': callable<() => Promise<TagSnapshot>>()('tags', [
    'tags:snapshot',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'tags.update': callable<(request: UpdateTagRequest) => Promise<TagSnapshot>>()('tags', [
    'tags:update',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ])
} as const

export const scheduleContracts = {
  'schedules.onChanged': callable<
    (listener: AcpListener<{ projectId: string; sessionId: string | null }>) => RemoveListener
  >()('schedules', ['schedules:changed', EVENT]),
  'schedules.history': callable<(request: ScheduleHistoryRequest) => Promise<ScheduleRun[]>>()(
    'schedules',
    ['schedules:history', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'schedules.list': callable<(request: ScheduleListRequest) => Promise<ScheduleSummary[]>>()(
    'schedules',
    ['schedules:list', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'schedules.get': callable<(request: ScheduleHistoryRequest) => Promise<ScheduleView | null>>()(
    'schedules',
    ['schedules:get', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'schedules.create': callable<(request: ScheduleCreateRequest) => Promise<ScheduleView>>()(
    'schedules',
    ['schedules:create', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'schedules.delete': callable<(request: ScheduleDeleteRequest) => Promise<void>>()('schedules', [
    'schedules:delete',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'schedules.edit': callable<(request: ScheduleEditRequest) => Promise<ScheduleView>>()(
    'schedules',
    ['schedules:edit', WEB, undefined, undefined, RUNTIME_VALIDATED]
  )
} as const
