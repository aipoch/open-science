import type {
  ArtifactPreviewResult,
  ReadArtifactPreviewRequest
} from '../../../../../shared/artifacts'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'
import type { AcquireManagedPreviewRequest } from '../../../../../shared/preview-resources'
import { parseUploadVersionReference } from '../../../../../shared/uploads'

type PreviewFileReader = (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>

type PreviewRequestIdentity = {
  projectId?: string
  sessionId?: string
  source?: PreviewFileSource
  path: string
}

type ManagedPreviewRequestInput = PreviewRequestIdentity & {
  managedFileId?: string
  selectedVersionId?: string
  mimeType?: string
  maxBytes?: number
}

// Version locators carry their immutable source Session. Use that trusted locator scope instead of
// the Session currently displaying an @ mention, while legacy managed paths retain their owner scope.
const createPreviewRequestScope = ({
  projectId,
  sessionId,
  source,
  path
}: PreviewRequestIdentity): Pick<ReadArtifactPreviewRequest, 'projectId' | 'sessionId'> => {
  const uploadVersion = source === 'upload' ? parseUploadVersionReference(path) : undefined
  const sourceSessionId = uploadVersion?.sessionId ?? sessionId

  return {
    ...(projectId ? { projectId } : {}),
    ...(sourceSessionId ? { sessionId: sourceSessionId } : {})
  }
}

const createManagedPreviewRequest = (
  input: ManagedPreviewRequestInput
): AcquireManagedPreviewRequest => {
  const source = input.source ?? 'artifact'
  const scope = createPreviewRequestScope({ ...input, source })
  const presentation = {
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
  }

  if (source === 'artifact' || source === 'upload') {
    if (!scope.projectId || !input.managedFileId) {
      throw new Error('Managed preview requires a logical identity.')
    }
    return {
      source,
      projectId: scope.projectId,
      fileId: input.managedFileId,
      ...(input.selectedVersionId ? { versionId: input.selectedVersionId } : {}),
      ...presentation
    }
  }

  return {
    source,
    path: input.path,
    ...scope,
    ...presentation
  }
}

// Selects the managed IPC reader once so callers remain source-neutral.
const getPreviewFileReader = (source: PreviewFileSource = 'artifact'): PreviewFileReader => {
  if (source === 'upload') return window.api.uploads.readPreview
  if (source === 'notebook-input') return window.api.notebook.readInputPreview
  if (source === 'local') return window.api.localFs.readPreview
  return window.api.artifacts.readPreview
}

export { createManagedPreviewRequest, createPreviewRequestScope, getPreviewFileReader }
export type { PreviewFileReader }
