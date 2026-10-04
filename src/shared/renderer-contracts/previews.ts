import type { PdfReconcileRequest, PdfSharingPreview } from '../pdf-annotations'
// Ordered fragments keep the public registration order when capabilities interleave.
import type { PdfAnnotationsChangedEvent } from '../pdf-annotations'

import type {
  ParsePdfStructureRequest,
  ReadCachedPdfStructureRequest,
  ReadPdfStructureThumbnailRequest,
  PdfStructureResult
} from '../pdf-structure'

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

export const previewDeleteContracts = {
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
