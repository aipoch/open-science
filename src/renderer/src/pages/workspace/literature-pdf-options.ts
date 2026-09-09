import { readLiteratureSelectionPage } from '../literature/literature-read-pages'
import {
  createLiteratureAttachmentVersionReference,
  type LiteratureAttachmentVersionView,
  type LiteratureCollectionView,
  type LiteratureItemView
} from '../../../../shared/literature'
import type {
  LiteratureReference,
  LiteratureScopeReference,
  SessionPdfContextSource
} from '../../../../shared/session-persistence'

export type LiteraturePdfOption = Readonly<{
  itemId: string
  name: string
  filename: string
  description: string
  path: string
  mimeType: string
  size: number
  source: SessionPdfContextSource
}>

export type LiteratureMentionOption = Readonly<{
  reference: LiteratureReference
  name: string
  description: string
  iconName: string
}>

export type LiteratureCollectionMentionOption = Readonly<{
  reference: LiteratureScopeReference
  name: string
}>

const isItem = (entry: unknown): entry is LiteratureItemView =>
  typeof entry === 'object' && entry !== null && 'item' in entry && 'attachments' in entry

const isCollection = (entry: unknown): entry is LiteratureCollectionView =>
  typeof entry === 'object' && entry !== null && 'name' in entry && 'itemCount' in entry

const isPdf = (version: LiteratureAttachmentVersionView): boolean =>
  version.contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
  version.filename.toLowerCase().endsWith('.pdf')

const creatorLabel = (item: LiteratureItemView): string =>
  item.item.creators
    .slice(0, 2)
    .map((creator) =>
      creator.nameMode === 'organization'
        ? creator.literalName
        : [creator.familyName, creator.givenName].filter(Boolean).join(', ')
    )
    .filter(Boolean)
    .join('; ')

const preferredPdfVersion = (
  item: LiteratureItemView,
  multiPageOnly: boolean
): LiteratureAttachmentVersionView | undefined =>
  item.attachments
    .flatMap((attachment) => attachment.versions.map((version) => ({ attachment, version })))
    .filter(({ version }) => isPdf(version) && (!multiPageOnly || (version.pageCount ?? 2) > 1))
    .sort(
      (left, right) =>
        Number(right.attachment.kind === 'fullText') -
          Number(left.attachment.kind === 'fullText') ||
        right.version.versionNumber - left.version.versionNumber ||
        right.version.createdAt - left.version.createdAt
    )[0]?.version

export const literatureItemToPdfOption = (
  item: LiteratureItemView,
  { multiPageOnly = true }: { multiPageOnly?: boolean } = {}
): LiteraturePdfOption | undefined => {
  const version = preferredPdfVersion(item, multiPageOnly)
  if (!version) return undefined
  return {
    itemId: item.id,
    name: item.item.title || version.filename,
    filename: version.filename,
    description: [creatorLabel(item), item.item.issuedYear].filter(Boolean).join(' · '),
    path: createLiteratureAttachmentVersionReference(version.id),
    mimeType: version.contentType,
    size: version.sizeBytes,
    source: {
      sourceKind: 'literature-attachment-version',
      sourceVersionId: version.id
    }
  }
}

export const searchLiteraturePdfOptions = async (
  query: string,
  { projectId }: { projectId?: string } = {}
): Promise<LiteraturePdfOption[]> => {
  const options: LiteraturePdfOption[] = []
  let offset: number | undefined
  do {
    const page = await readLiteratureSelectionPage({
      scope: 'library',
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(projectId ? { projectId } : {}),
      ...(offset !== undefined ? { offset } : {}),
      limit: 100
    })
    for (const entry of page.entries) {
      if (!isItem(entry)) continue
      const option = literatureItemToPdfOption(entry)
      if (option) options.push(option)
    }
    offset = page.nextOffset
  } while (offset !== undefined)
  return options
}

export const literatureItemToMentionOption = (
  item: LiteratureItemView
): LiteratureMentionOption => {
  const pdf = preferredPdfVersion(item, true)
  return {
    reference: {
      type: 'literature',
      itemId: item.id,
      metadataRevision: item.metadataRevision,
      item: item.item,
      ...(pdf ? { attachmentVersionId: pdf.id } : {})
    },
    name: item.item.title,
    description: [creatorLabel(item), item.item.issuedYear, item.item.containerTitle]
      .filter(Boolean)
      .join(' · '),
    iconName: pdf?.filename ?? `${item.item.title}.bib`
  }
}

export const searchLiteratureMentionOptions = async (
  query: string,
  { projectId }: { projectId?: string } = {}
): Promise<LiteratureMentionOption[]> => {
  const page = await readLiteratureSelectionPage({
    scope: 'library',
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(projectId ? { projectId } : {}),
    limit: 100
  })
  return page.entries.flatMap((entry) =>
    isItem(entry) ? [literatureItemToMentionOption(entry)] : []
  )
}

export const searchLiteratureCollectionMentionOptions = async (
  query: string
): Promise<LiteratureCollectionMentionOption[]> => {
  const page = await readLiteratureSelectionPage({
    scope: 'collections',
    ...(query.trim() ? { query: query.trim() } : {}),
    limit: 20
  })
  return page.entries.flatMap((entry) =>
    isCollection(entry)
      ? [
          {
            reference: {
              type: 'literature-scope' as const,
              scope: 'collection' as const,
              collectionId: entry.id,
              name: entry.name
            },
            name: entry.name
          }
        ]
      : []
  )
}
