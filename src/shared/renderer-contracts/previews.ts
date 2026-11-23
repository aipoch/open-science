import type {
  ImageTask,
  ImageTaskStart,
  ImageTaskList,
  ImageTaskIdentity,
  ImageTaskStartResult
} from '../image-task'
import type {
  ResearchVideoActiveSession,
  ResearchVideoPresentationRequest,
  ResearchVideoStartRequest,
  ResearchVideoStatusRequest,
  ResearchVideoPresentationStatus
} from '../research-video-presentation'
import type {
  ResearchVideoProgress,
  ResearchVideoExportResult,
  ResearchVideoResolution
} from '@aipoch/research-film/contracts'
import type { PdfReconcileRequest, PdfSharingPreview } from '../pdf-annotations'
// Ordered fragments keep the public registration order when capabilities interleave.
import type { PdfAnnotationsChangedEvent } from '../pdf-annotations'

import type {
  ParsePdfStructureRequest,
  ReadCachedPdfStructureRequest,
  ReadPdfStructureThumbnailRequest
} from '../pdf-structure'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'

import type {
  SourcePreviewContextMenuRequest,
  SourcePreviewNavigationBlocked
} from '../source-preview'

import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PreviewStateSnapshot,
  SavePreviewStateResult,
  SavePreviewStateRequest
} from '../preview-state'

import type { SaveTextEditResult } from '../managed-file-versions'
import type {
  PptxEditSessionApplyRequest,
  PptxEditSessionOpenRequest,
  PptxEditSessionResult,
  PptxEditSessionSaveRequest,
  PptxEditSessionView
} from '../pptx-edit-session'
import type {
  PptxDraftAcceptOutcome,
  PptxDraftChangedEvent,
  PptxDraftReviewRequest,
  PptxDraftSummary
} from '../pptx-draft'
import type { ManagedFileIdentity } from '../managed-file-versions'
import type {
  OfficePreviewAttachResult,
  OfficePreviewOpenRequest,
  OfficePreviewOpenResult,
  OfficePreviewRuntimeState
} from '../office-preview'

import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../preview-resources'

import {
  PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL,
  type PreviewContextMenuRequest
} from '../preview-context-menu'

import type {
  CreatePdfAnnotationRequest,
  DeletePdfAnnotationRequest,
  DeletePdfAnnotationResult,
  ListPdfAnnotationsRequest,
  PdfAnnotation,
  PdfAnnotationListResult,
  PdfNativeAnnotationCancelRequest,
  PdfNativeAnnotationImportProgress,
  PdfNativeAnnotationImportRequest,
  PdfNativeAnnotationImportResult,
  UpdatePdfAnnotationRequest
} from '../pdf-annotations'

import {
  SOURCE_PREVIEW_CONTEXT_MENU_CHANNEL,
  SOURCE_PREVIEW_NAVIGATION_BLOCKED_CHANNEL
} from '../source-preview'

import {
  callable,
  ELECTRON,
  type RemoveListener,
  ELECTRON_EVENT,
  SEND,
  type AcpListener,
  WEB,
  RUNTIME_VALIDATED,
  EVENT,
  LOCAL
} from './definition'

export const officePreviewAttachFrameContracts = {
  'officePreview.attachFrame': callable<
    (sessionId: string) => Promise<OfficePreviewAttachResult | undefined>
  >()('office-preview', ['office-preview:attach-frame', ELECTRON]),
  'officePreview.close': callable<(sessionId: string) => Promise<void>>()('office-preview', [
    'office-preview:close',
    ELECTRON
  ]),
  'officePreview.onState': callable<
    (listener: (state: OfficePreviewRuntimeState) => void) => RemoveListener
  >()('office-preview', ['office-preview:state', ELECTRON_EVENT]),
  'officePreview.open': callable<
    (request: OfficePreviewOpenRequest) => Promise<OfficePreviewOpenResult>
  >()('office-preview', ['office-preview:open', ELECTRON]),
  'officePreview.reportState': callable<
    (sessionId: string, state: OfficePreviewRuntimeState) => void
  >()('office-preview', ['office-preview:report-state', SEND])
} as const

export const pptxEditContracts = {
  'pptxEdit.apply': callable<
    (request: PptxEditSessionApplyRequest) => Promise<PptxEditSessionResult<PptxEditSessionView>>
  >()('pptx-edit', ['pptx-edit:apply', ELECTRON]),
  'pptxEdit.close': callable<(sessionId: string) => Promise<void>>()('pptx-edit', [
    'pptx-edit:close',
    ELECTRON
  ]),
  'pptxEdit.open': callable<
    (request: PptxEditSessionOpenRequest) => Promise<PptxEditSessionResult<PptxEditSessionView>>
  >()('pptx-edit', ['pptx-edit:open', ELECTRON]),
  'pptxEdit.save': callable<
    (request: PptxEditSessionSaveRequest) => Promise<PptxEditSessionResult<SaveTextEditResult>>
  >()('pptx-edit', ['pptx-edit:save', ELECTRON])
} as const

export const pptxDraftContracts = {
  'pptxDraft.accept': callable<
    (request: PptxDraftReviewRequest) => Promise<PptxDraftAcceptOutcome>
  >()('pptx-draft', ['pptx-draft:accept', ELECTRON]),
  'pptxDraft.get': callable<(identity: ManagedFileIdentity) => Promise<PptxDraftSummary | null>>()(
    'pptx-draft',
    ['pptx-draft:get', ELECTRON]
  ),
  'pptxDraft.onChanged': callable<
    (listener: AcpListener<PptxDraftChangedEvent>) => RemoveListener
  >()('pptx-draft', ['pptx-draft:changed', EVENT]),
  'pptxDraft.reject': callable<(request: PptxDraftReviewRequest) => Promise<boolean>>()(
    'pptx-draft',
    ['pptx-draft:reject', ELECTRON]
  )
} as const

export const previewDeleteContracts = {
  'imageTasks.start': callable<(request: ImageTaskStart) => Promise<ImageTaskStartResult>>()(
    'preview-resources',
    ['image-tasks:start']
  ),
  'imageTasks.get': callable<(request: ImageTaskIdentity) => Promise<ImageTask | undefined>>()(
    'preview-resources',
    ['image-tasks:get']
  ),
  'imageTasks.list': callable<(request: ImageTaskList) => Promise<ImageTask[]>>()(
    'preview-resources',
    ['image-tasks:list']
  ),
  'imageTasks.cancel': callable<(request: ImageTaskIdentity) => Promise<void>>()(
    'preview-resources',
    ['image-tasks:cancel']
  ),
  'preview.delete': callable<(request: DeletePreviewStateRequest) => Promise<void>>()('preview', [
    'preview:delete'
  ]),
  'preview.load': callable<
    (request: LoadPreviewStateRequest) => Promise<PreviewStateSnapshot | null>
  >()('preview', ['preview:load']),
  'preview.save': callable<(request: SavePreviewStateRequest) => Promise<SavePreviewStateResult>>()(
    'preview',
    ['preview:save']
  ),
  'previewContextMenu.onRequested': callable<
    (listener: AcpListener<PreviewContextMenuRequest>) => RemoveListener
  >()('preview-context-menu', [PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL, ELECTRON_EVENT]),
  'previewResources.acquire': callable<
    (request: AcquireManagedPreviewRequest) => Promise<ManagedPreviewResource>
  >()('preview-resources', ['preview-resources:acquire']),
  'previewResources.readRange': callable<
    (request: ReadManagedPreviewRangeRequest) => Promise<ManagedPreviewRangeResult>
  >()('preview-resources', ['preview-resources:read-range']),
  'previewResources.exportResearchVideo': callable<
    (request: {
      resourceId: string
      resolution?: ResearchVideoResolution
    }) => Promise<ResearchVideoExportResult>
  >()('preview-resources', ['preview-resources:export-research-video', ELECTRON]),
  'researchVideo.activeSessions': callable<() => Promise<readonly ResearchVideoActiveSession[]>>()(
    'preview-resources',
    ['research-video:active-sessions', ELECTRON]
  ),
  'researchVideo.start': callable<
    (request: ResearchVideoStartRequest) => Promise<ResearchVideoPresentationStatus>
  >()('preview-resources', ['research-video:start', ELECTRON]),
  'researchVideo.status': callable<
    (request: ResearchVideoStatusRequest) => Promise<ResearchVideoPresentationStatus>
  >()('preview-resources', ['research-video:status', ELECTRON]),
  'researchVideo.remove': callable<
    (request: ResearchVideoPresentationRequest) => Promise<ResearchVideoPresentationStatus>
  >()('preview-resources', ['research-video:remove', ELECTRON]),
  'researchVideo.cancel': callable<(request: ResearchVideoPresentationRequest) => Promise<void>>()(
    'preview-resources',
    ['research-video:cancel', ELECTRON]
  ),
  'researchVideo.onActivityChanged': callable<
    (listener: (sessions: readonly ResearchVideoActiveSession[]) => void) => RemoveListener
  >()('preview-resources', ['research-video:activity-changed', ELECTRON_EVENT]),
  'previewResources.researchVideoExportProgress': callable<
    (request: { resourceId: string }) => Promise<ResearchVideoProgress | null>
  >()('preview-resources', ['preview-resources:research-video-progress', ELECTRON]),
  'previewResources.cancelResearchVideoExport': callable<
    (request: { resourceId: string }) => Promise<void>
  >()('preview-resources', ['preview-resources:cancel-research-video-export', ELECTRON]),
  'previewResources.release': callable<(request: ReleaseManagedPreviewRequest) => Promise<void>>()(
    'preview-resources',
    ['preview-resources:release']
  )
} as const

export const sourcePreviewOnNavigationBlockedContracts = {
  'sourcePreview.onNavigationBlocked': callable<
    (listener: (request: SourcePreviewNavigationBlocked) => void) => RemoveListener
  >()('source-preview', [SOURCE_PREVIEW_NAVIGATION_BLOCKED_CHANNEL, ELECTRON_EVENT], {
    optionalRoot: true
  }),
  'sourcePreview.onContextMenu': callable<
    (listener: (request: SourcePreviewContextMenuRequest) => void) => RemoveListener
  >()('source-preview', [SOURCE_PREVIEW_CONTEXT_MENU_CHANNEL, ELECTRON_EVENT], {
    optionalRoot: true
  })
} as const

export const pdfAnnotationsListContracts = {
  'pdfAnnotations.reconcile': callable<
    (request: PdfReconcileRequest) => Promise<PdfSharingPreview | null>
  >()('pdf-annotations', [
    'pdf-annotations:reconcile',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'pdfAnnotations.list': callable<
    (request: ListPdfAnnotationsRequest) => Promise<PdfAnnotationListResult>
  >()('pdf-annotations', ['pdf-annotations:list', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'pdfAnnotations.create': callable<
    (request: CreatePdfAnnotationRequest) => Promise<PdfAnnotation>
  >()('pdf-annotations', ['pdf-annotations:create', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'pdfAnnotations.update': callable<
    (request: UpdatePdfAnnotationRequest) => Promise<PdfAnnotation>
  >()('pdf-annotations', ['pdf-annotations:update', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'pdfAnnotations.delete': callable<
    (request: DeletePdfAnnotationRequest) => Promise<DeletePdfAnnotationResult>
  >()('pdf-annotations', ['pdf-annotations:delete', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'pdfAnnotations.importNative': callable<
    (request: PdfNativeAnnotationImportRequest) => Promise<PdfNativeAnnotationImportResult>
  >()('pdf-annotations', [
    'pdf-annotations:import-native',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'pdfAnnotations.cancelImport': callable<
    (request: PdfNativeAnnotationCancelRequest) => Promise<{ cancelled: boolean }>
  >()('pdf-annotations', [
    'pdf-annotations:cancel-import',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'pdfAnnotations.onChanged': callable<
    (listener: AcpListener<PdfAnnotationsChangedEvent>) => RemoveListener
  >()('pdf-annotations', ['pdf-annotations:changed', EVENT]),
  'pdfAnnotations.onImportProgress': callable<
    (listener: AcpListener<PdfNativeAnnotationImportProgress>) => RemoveListener
  >()('pdf-annotations', ['pdf-annotations:import-progress', EVENT])
} as const

export const pdfStructureReadCachedContracts = {
  'pdfStructure.readCached': callable<
    (request: ReadCachedPdfStructureRequest) => Promise<PdfStructureResult | undefined>
  >()('pdf-structure', [
    'pdf-structure:read-cached',
    LOCAL,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'pdfStructure.parse': callable<
    (request: ParsePdfStructureRequest) => Promise<PdfStructureResult>
  >()('pdf-structure', ['pdf-structure:parse', LOCAL, undefined, undefined, RUNTIME_VALIDATED]),
  'pdfStructure.cancel': callable<(requestId: string) => Promise<void>>()('pdf-structure', [
    'pdf-structure:cancel',
    LOCAL,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'pdfStructure.readThumbnail': callable<
    (request: ReadPdfStructureThumbnailRequest) => Promise<string | undefined>
  >()('pdf-structure', [
    'pdf-structure:read-thumbnail',
    LOCAL,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'pdfStructure.clearCache': callable<
    () => Promise<{ removedBytes: number; retainedEntries: number }>
  >()('pdf-structure', [
    'pdf-structure:clear-cache',
    LOCAL,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ])
} as const
