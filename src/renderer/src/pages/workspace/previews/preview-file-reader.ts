import type {
  ArtifactPreviewResult,
  ReadArtifactPreviewRequest
} from '../../../../../shared/artifacts'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'
import { parseUploadVersionReference } from '../../../../../shared/uploads'

type PreviewFileReader = (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>

type PreviewRequestIdentity = {
  projectId?: string
  sessionId?: string
  source?: PreviewFileSource
  path: string
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

// Selects the managed IPC reader once so callers remain source-neutral.
const getPreviewFileReader = (source: PreviewFileSource = 'artifact'): PreviewFileReader =>
  source === 'upload'
    ? window.api.uploads.readPreview
    : source === 'notebook-input'
      ? window.api.notebook.readInputPreview
      : window.api.artifacts.readPreview

export { createPreviewRequestScope, getPreviewFileReader }
export type { PreviewFileReader }
