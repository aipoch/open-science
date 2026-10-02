import type { ManuscriptExportFormat } from '../../../../shared/manuscripts'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { createPreviewRequestScope, getPreviewFileReader } from './previews/preview-file-reader'

const MAX_MANUSCRIPT_PREVIEW_BYTES = 5 * 1024 * 1024

const decodeBase64 = (content: string): ArrayBuffer => {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

const readManuscriptText = async (item: PreviewFileItem): Promise<string> => {
  const source = item.source ?? 'artifact'
  const preview = await getPreviewFileReader(source)({
    path: item.path,
    ...createPreviewRequestScope(item),
    ...(source === 'artifact' || source === 'upload'
      ? { fileId: item.managedFileId ?? item.artifactId }
      : {}),
    ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {}),
    maxBytes: MAX_MANUSCRIPT_PREVIEW_BYTES,
    encoding: 'utf8'
  })
  if (preview.encoding !== 'utf8' || preview.truncated) {
    throw new Error('Manuscript is too large to export from the workspace preview.')
  }
  return preview.content
}

const exportManuscript = async (
  item: PreviewFileItem,
  format: ManuscriptExportFormat
): Promise<{ saved: boolean; filePath?: string }> => {
  const content = await readManuscriptText(item)
  const result = await window.api.manuscripts.render({
    projectId: item.projectId ?? 'default-project',
    appSessionId: item.sessionId,
    content,
    format,
    filename: item.name
  })
  return window.api.saveBlobFile({
    suggestedName: result.filename,
    mimeType: result.mimeType,
    data: decodeBase64(result.dataBase64)
  })
}

export { MAX_MANUSCRIPT_PREVIEW_BYTES, exportManuscript, readManuscriptText }
