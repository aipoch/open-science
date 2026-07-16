import type {
  ArtifactPreviewResult,
  ReadArtifactPreviewRequest
} from '../../../../../shared/artifacts'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

type PreviewFileReader = (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>

// Selects the managed IPC reader once so callers remain source-neutral.
const getPreviewFileReader = (source: PreviewFileSource = 'artifact'): PreviewFileReader =>
  source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

export { getPreviewFileReader }
export type { PreviewFileReader }
