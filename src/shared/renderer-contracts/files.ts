// Ordered fragments keep the public registration order when capabilities interleave.
import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../artifacts'

import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from '../file-save'

import type {
  ManagedFileVersionCancelDiffRequest,
  ManagedFileVersionDiffRequest,
  ManagedFileVersionDiffResult,
  ManagedFileVersionInspectRequest,
  ManagedFileVersionInspectResult,
  ManagedFileVersionIpcResult,
  ManagedFileVersionSaveTextEditRequest,
  SaveTextEditResult
} from '../managed-file-versions'

import type {
  GrantLocalRootRequest,
  GrantedLocalRoot,
  LocalDirListing,
  LocalDrive,
  LocalRoots,
  RemoveGrantedLocalRootRequest,
  SetGrantedLocalRootAccessRequest
} from '../local-fs'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ReadProjectExportFilesRequest,
  ProjectFileItem,
  ProjectFilesChangedEvent,
  ProjectFilesOverview,
  ProjectFilesPage,
  ResolveProjectFileRequest,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../project-files'

import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalPathUploadRequest,
  UploadTransferProgress,
  UploadTransferRequest,
  UploadTransferStatus,
  UploadedAttachment
} from '../uploads'

import {
  callable,
  NATIVE,
  LOCAL,
  ELECTRON,
  value,
  type AcpListener,
  type RemoveListener,
  EVENT,
  MAPPED_NATIVE,
  DELEGATED_NATIVE,
  MAPPED_ELECTRON,
  WEB,
  RUNTIME_VALIDATED,
  ELECTRON_EVENT,
  NATIVE_FILE_UPLOAD
} from './definition'

export const getRuntimeVersionsContracts = {
  getRuntimeVersions: callable<
    () => {
      electron?: string
      chrome?: string
      node: string
    }
  >()('platform-file-save', [null, NATIVE])
} as const

export const localFsGetRootsContracts = {
  'localFs.getRoots': callable<() => Promise<LocalRoots>>()('local-fs', [
    'local-fs:get-roots',
    LOCAL
  ]),
  'localFs.grantRoot': callable<(request: GrantLocalRootRequest) => Promise<GrantedLocalRoot[]>>()(
    'local-fs',
    ['local-fs:grant-root', LOCAL]
  ),
  'localFs.listDir': callable<(path: string) => Promise<LocalDirListing>>()('local-fs', [
    'local-fs:list-dir',
    LOCAL
  ]),
  'localFs.listDrives': callable<() => Promise<LocalDrive[]>>()('local-fs', [
    'local-fs:list-drives',
    LOCAL
  ]),
  'localFs.listGrantedRoots': callable<() => Promise<GrantedLocalRoot[]>>()('local-fs', [
    'local-fs:granted-roots:list',
    LOCAL
  ]),
  'localFs.openPath': callable<(path: string) => Promise<string>>()('local-fs', [
    'local-fs:open-path',
    LOCAL
  ]),
  'localFs.readPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('local-fs', ['local-fs:read-preview', LOCAL]),
  'localFs.removeGrantedRoot': callable<
    (request: RemoveGrantedLocalRootRequest) => Promise<GrantedLocalRoot[]>
  >()('local-fs', ['local-fs:granted-roots:remove', LOCAL]),
  'localFs.reveal': callable<(path: string) => Promise<void>>()('local-fs', [
    'local-fs:reveal',
    LOCAL
  ]),
  'localFs.setGrantedRootAccess': callable<
    (request: SetGrantedLocalRootAccessRequest) => Promise<GrantedLocalRoot[]>
  >()('local-fs', ['local-fs:granted-roots:set-access', LOCAL])
} as const

export const managedFileVersionsCancelDiffContracts = {
  'managedFileVersions.cancelDiff': callable<
    (
      request: ManagedFileVersionCancelDiffRequest
    ) => Promise<ManagedFileVersionIpcResult<{ cancelled: boolean }>>
  >()('managed-file-versions', ['managed-file-versions:cancel-diff', ELECTRON]),
  'managedFileVersions.diffText': callable<
    (
      request: ManagedFileVersionDiffRequest
    ) => Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>
  >()('managed-file-versions', ['managed-file-versions:diff-text', ELECTRON]),
  'managedFileVersions.inspect': callable<
    (
      request: ManagedFileVersionInspectRequest
    ) => Promise<ManagedFileVersionIpcResult<ManagedFileVersionInspectResult>>
  >()('managed-file-versions', ['managed-file-versions:inspect', ELECTRON]),
  'managedFileVersions.saveTextEdit': callable<
    (
      request: ManagedFileVersionSaveTextEditRequest
    ) => Promise<ManagedFileVersionIpcResult<SaveTextEditResult>>
  >()('managed-file-versions', ['managed-file-versions:save-text-edit', ELECTRON])
} as const

export const platformContracts = {
  platform: value<string>()('platform-file-save')
} as const

export const projectFilesGetOverviewContracts = {
  'projectFiles.getOverview': callable<
    (request: GetProjectFilesOverviewRequest) => Promise<ProjectFilesOverview>
  >()('project-files', ['project-files:get-overview']),
  'projectFiles.listArtifactGroups': callable<
    (request: ListArtifactGroupsRequest) => Promise<ArtifactGroupPage>
  >()('project-files', ['project-files:list-artifact-groups']),
  'projectFiles.listFiles': callable<
    (request: ListProjectFilesRequest) => Promise<ProjectFilesPage>
  >()('project-files', ['project-files:list-files']),
  'projectFiles.readExportFiles': callable<
    (request: ReadProjectExportFilesRequest) => Promise<ProjectFileItem[]>
  >()('project-files', ['project-files:read-export-files']),
  'projectFiles.resolveFile': callable<
    (request: ResolveProjectFileRequest) => Promise<ProjectFileItem | undefined>
  >()('project-files', ['project-files:resolve-file']),
  'projectFiles.onChanged': callable<
    (listener: AcpListener<ProjectFilesChangedEvent>) => RemoveListener
  >()('project-files', ['project-files:changed', EVENT]),
  'projectFiles.repairIndex': callable<(request: { projectId: string }) => Promise<void>>()(
    'project-files',
    ['project-files:repair-index']
  ),
  'projectFiles.searchArtifacts': callable<
    (request: SearchArtifactsRequest) => Promise<SearchArtifactsResult>
  >()('project-files', ['project-files:search-artifacts'])
} as const

export const saveBlobFileContracts = {
  saveBlobFile: callable<(request: SaveBlobFileRequest) => Promise<SaveBlobFileResult>>()(
    'platform-file-save',
    ['file:save-blob', MAPPED_NATIVE]
  ),
  saveManagedFile: callable<(request: SaveManagedFileRequest) => Promise<SaveManagedFileResult>>()(
    'platform-file-save',
    ['file:save-managed', DELEGATED_NATIVE]
  ),
  saveProjectArtifacts: callable<
    (request: SaveProjectArtifactsRequest) => Promise<SaveProjectArtifactsResult>
  >()('platform-file-save', ['file:save-project-artifacts', MAPPED_ELECTRON]),
  saveSessionArtifacts: callable<
    (request: SaveSessionArtifactsRequest) => Promise<SaveSessionArtifactsResult>
  >()('platform-file-save', ['file:save-session-artifacts', MAPPED_ELECTRON])
} as const

export const uploadsAbortTransferContracts = {
  'uploads.abortTransfer': callable<(request: UploadTransferRequest) => Promise<void>>()(
    'uploads',
    ['uploads:abort-transfer']
  ),
  'uploads.appendTransfer': callable<
    (request: AppendUploadTransferRequest) => Promise<UploadTransferStatus>
  >()('uploads', ['uploads:append-transfer']),
  'uploads.beginTransfer': callable<
    (request: BeginUploadTransferRequest) => Promise<UploadTransferStatus>
  >()('uploads', ['uploads:begin-transfer']),
  'uploads.claimLocalFile': callable<(request: UploadTransferRequest) => Promise<void>>()(
    'uploads',
    ['uploads:claim-local-file'],
    { optionalMember: true }
  ),
  'uploads.deleteUpload': callable<(request: DeleteUploadRequest) => Promise<void>>()('uploads', [
    'uploads:delete'
  ]),
  'uploads.finalizeSession': callable<
    (request: FinalizeUploadSessionRequest) => Promise<UploadedAttachment[]>
  >()('uploads', ['uploads:finalize-session', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'uploads.finishTransfer': callable<
    (request: UploadTransferRequest) => Promise<UploadedAttachment>
  >()('uploads', ['uploads:finish-transfer']),
  'uploads.getTransferStatus': callable<
    (request: UploadTransferRequest) => Promise<UploadTransferStatus | null>
  >()('uploads', ['uploads:transfer-status']),
  'uploads.onTransferProgress': callable<
    (listener: AcpListener<UploadTransferProgress>) => RemoveListener
  >()('uploads', ['uploads:transfer-progress', ELECTRON_EVENT], { optionalMember: true }),
  'uploads.recoverDraft': callable<
    (request: { receipt: string }) => Promise<UploadedAttachment | null>
  >()('uploads', ['uploads:recover-draft', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'uploads.readPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('uploads', ['uploads:read-preview']),
  'uploads.stageLocalFile': callable<
    (file: File, request: BeginUploadTransferRequest) => Promise<UploadedAttachment | null>
  >()('uploads', ['uploads:stage-local-file', MAPPED_ELECTRON, NATIVE_FILE_UPLOAD], {
    optionalMember: true
  }),
  'uploads.stageLocalPath': callable<
    (request: StageLocalPathUploadRequest) => Promise<UploadedAttachment>
  >()('uploads', ['uploads:stage-local-path', LOCAL], { optionalMember: true })
} as const
