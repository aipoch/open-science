import type { Project } from '../../../../shared/projects'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { MessageSearchItem } from '../../../../shared/message-search'
import type { LiteratureCollectionView, LiteratureItemView } from '../../../../shared/literature'
import type { SearchableSession } from './global-search-catalog'
import {
  createPreviewFileItem,
  LITERATURE_PREVIEW_SESSION_ID
} from '@/pages/workspace/preview-file-item'
import { literatureItemToPdfOption } from '@/pages/workspace/literature-pdf-options'

export type SearchSession = SearchableSession & { activeMessageCount: number }
export type SearchResult =
  | { kind: 'messages'; item: MessageSearchItem }
  | { kind: 'sessions'; item: SearchSession }
  | { kind: 'projects'; item: Project }
  | { kind: 'uploads' | 'generated'; item: ProjectFileItem }
  | { kind: 'library'; item: LiteratureItemView | LiteratureCollectionView }
export type SearchCategory = SearchResult['kind']
export const SEARCH_CATEGORIES = [
  'messages',
  'sessions',
  'projects',
  'uploads',
  'generated',
  'library'
] as const
export const SEARCH_GROUP_ORDER = [
  'projects',
  'messages',
  'sessions',
  'uploads',
  'generated',
  'library'
] as const
export const messageTitle = (item: MessageSearchItem): string =>
  item.title || item.content.trim().split(/\r?\n/, 1)[0] || item.sessionTitle
export const fileFormatLabel = (item: ProjectFileItem): string =>
  item.name.includes('.') ? item.name.split('.').at(-1)!.toUpperCase() : (item.mimeType ?? '')
export const resultId = (result: SearchResult): string =>
  result.kind === 'messages'
    ? `messages:${result.item.projectId}:${result.item.sessionId}:${result.item.messageId}`
    : `${result.kind}:${result.item.id}`
export const resultTitle = (result: SearchResult): string => {
  switch (result.kind) {
    case 'messages':
      return result.item.content
    case 'sessions':
      return result.item.title
    case 'projects':
      return result.item.name
    case 'uploads':
    case 'generated':
      return result.item.name
    case 'library':
      return 'item' in result.item ? result.item.item.title : result.item.name
  }
}
export const filePreviewItem = (file: ProjectFileItem): ReturnType<typeof createPreviewFileItem> =>
  createPreviewFileItem({
    id: file.id,
    projectId: file.projectId,
    sessionId: file.sessionId,
    path: file.path,
    name: file.name,
    mimeType: file.mimeType,
    source: file.source === 'upload' ? 'upload' : undefined,
    size: file.size,
    mtimeMs: file.mtimeMs,
    artifactId: file.source === 'artifact' ? file.sourceFileId : undefined,
    managedFileId: file.sourceFileId,
    // A text match refers to bytes in this immutable Version, even if the file head advances.
    selectedVersionId: file.contentMatch ? file.sourceVersionId : undefined,
    originSession: file.originSession
  })
export const literaturePreviewItem = (
  item: LiteratureItemView
): ReturnType<typeof createPreviewFileItem> | undefined => {
  const pdf = literatureItemToPdfOption(item, { multiPageOnly: false })
  return pdf
    ? createPreviewFileItem({
        id: `literature:${pdf.source.sourceVersionId}`,
        projectId: item.projectIds[0],
        sessionId: LITERATURE_PREVIEW_SESSION_ID,
        path: pdf.path,
        name: pdf.filename,
        mimeType: pdf.mimeType,
        size: pdf.size,
        source: 'literature'
      })
    : undefined
}
