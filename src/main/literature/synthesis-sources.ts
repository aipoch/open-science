import { Prisma, type PrismaClient } from '@prisma/client'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { preferredLiteratureIdentifier } from '@aipoch/literature-citations/contracts'
import type { PdfAnnotationRepository } from '../pdf-annotations/repository'
import {
  synthesisCandidateSchema,
  type SynthesisCandidate,
  type SynthesisCandidateCursor,
  type SynthesisExcerptSelection
} from '../../shared/literature-synthesis'

type Client = Pick<
  PrismaClient,
  | 'literatureAttachmentVersion'
  | 'pdfAnnotationSourceBinding'
  | 'pdfAnnotationAlias'
  | '$queryRaw'
  | 'tag'
>
const candidateResponseBudget = 1024 * 1024
export type SynthesisSources = {
  candidates(
    itemIds: string[],
    tagId?: string,
    cursor?: SynthesisCandidateCursor,
    limit?: number
  ): Promise<{ candidates: SynthesisCandidate[]; nextCursor?: SynthesisCandidateCursor }>
  resolve(selection: SynthesisExcerptSelection): Promise<SynthesisCandidate | undefined>
  canonicalIds(annotationIds: string[]): Promise<Map<string, string>>
}

/** Resolve membership via immutable attachment versions and their annotation bindings, never renderer quote/page data. */
export class LiteratureSynthesisSources implements SynthesisSources {
  constructor(
    private readonly getClient: () => Promise<Client>,
    private readonly annotations: Pick<PdfAnnotationRepository, 'list'>,
    private readonly catalog: { get(id: string): Promise<LiteratureItemView | undefined> }
  ) {}

  async canonicalIds(annotationIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(annotationIds)]
    if (!ids.length) return new Map()
    const client = await this.getClient()
    // Sharing keeps aliases flattened; this lookup only compares identity, never admits a source.
    const aliases = await client.pdfAnnotationAlias.findMany({
      where: { id: { in: ids } },
      select: { id: true, annotationId: true }
    })
    const targets = new Map(aliases.map((alias) => [alias.id, alias.annotationId]))
    return new Map(ids.map((id) => [id, targets.get(id) ?? id]))
  }

  async resolve(selection: SynthesisExcerptSelection): Promise<SynthesisCandidate | undefined> {
    const client = await this.getClient()
    const version = await client.literatureAttachmentVersion.findFirst({
      where: {
        id: selection.versionId,
        attachment: { itemId: selection.itemId, item: { deletedAt: null, mergedIntoItemId: null } }
      }
    })
    if (!version) return undefined
    const binding = await client.pdfAnnotationSourceBinding.findFirst({
      where: {
        versionId: version.id,
        sourceFileId: version.attachmentId,
        sourceKind: 'literature-attachment-version',
        projectId: null,
        checksum: version.checksum
      }
    })
    if (!binding) return undefined
    const result = await this.annotations.list({
      literatureVersionId: version.id,
      id: selection.annotationId,
      limit: 1
    })
    const annotation = result.items[0]
    if (
      !annotation ||
      (selection.expectedUpdatedAt !== undefined &&
        annotation.updatedAt !== selection.expectedUpdatedAt) ||
      annotation.target.source.kind !== 'literature-attachment-version' ||
      annotation.target.source.checksum !== version.checksum ||
      annotation.target.source.versionId !== version.id ||
      annotation.target.source.sourceFileId !== version.attachmentId
    )
      return undefined
    const paper = await this.catalog.get(selection.itemId)
    if (!paper || paper.deletedAt || paper.mergedIntoItemId) return undefined
    const tags = annotation.tagIds.length
      ? await client.tag.findMany({ where: { id: { in: annotation.tagIds } } })
      : []
    const doi = preferredLiteratureIdentifier(paper.item.identifiers, 'doi')?.value
    return synthesisCandidateSchema.parse({
      itemId: selection.itemId,
      versionId: selection.versionId,
      annotationId: annotation.id,
      annotation,
      bibliography: {
        itemId: paper.id,
        title: paper.item.title,
        authors: paper.item.creators
          .filter((creator) => creator.creatorType === 'author')
          .map((creator) =>
            creator.nameMode === 'organization'
              ? creator.literalName
              : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
          )
          .join(', '),
        ...(paper.item.issuedYear !== undefined
          ? { year: String(paper.item.issuedYear) }
          : paper.item.issuedText
            ? { year: paper.item.issuedText }
            : {}),
        ...(doi ? { doi } : {})
      },
      tags: tags.map((tag) => ({ id: tag.id, name: tag.name ?? tag.systemKey ?? tag.id }))
    })
  }

  async candidates(
    itemIds: string[],
    tagId?: string,
    cursor?: SynthesisCandidateCursor,
    limit = 50
  ): Promise<{ candidates: SynthesisCandidate[]; nextCursor?: SynthesisCandidateCursor }> {
    const client = await this.getClient()
    const versions = await client.literatureAttachmentVersion.findMany({
      where: {
        attachment: { itemId: { in: itemIds }, item: { deletedAt: null, mergedIntoItemId: null } }
      },
      select: { id: true, attachment: { select: { itemId: true } } },
      orderBy: { id: 'asc' },
      take: 2001
    })
    if (versions.length > 2000)
      throw new Error('Too many source versions. Select fewer references.')
    const bindings = await client.pdfAnnotationSourceBinding.findMany({
      where: {
        projectId: null,
        sourceKind: 'literature-attachment-version',
        versionId: { in: versions.map((version) => version.id) }
      },
      select: { documentId: true, versionId: true },
      orderBy: { versionId: 'asc' },
      take: 2001
    })
    if (bindings.length > 2000)
      throw new Error('Too many annotation sources. Select fewer references.')
    const documentIds = [...new Set(bindings.map((binding) => binding.documentId))]
    if (!documentIds.length) return { candidates: [] }
    // An EXISTS predicate avoids materializing every assignment for a popular library tag,
    // and keeps the SQL parameter count bounded by the selected source versions.
    const rows = await client.$queryRaw<
      { id: string; documentId: string; createdAt: Date }[]
    >(Prisma.sql`
      SELECT annotation.id, annotation.documentId, annotation.createdAt FROM PdfAnnotation annotation
      WHERE annotation.documentId IN (${Prisma.join(documentIds)})
      ${
        cursor
          ? Prisma.sql`AND (annotation.createdAt > ${new Date(cursor.createdAt)}
            OR (annotation.createdAt = ${new Date(cursor.createdAt)} AND annotation.id > ${cursor.id}))`
          : Prisma.empty
      }
      ${
        tagId
          ? Prisma.sql`AND EXISTS (SELECT 1 FROM TagAssignment assignment
        WHERE assignment.resourceType = 'pdf.annotation'
        AND assignment.resourceId = annotation.id AND assignment.tagId = ${tagId})`
          : Prisma.empty
      }
      ORDER BY annotation.createdAt ASC, annotation.id ASC
      LIMIT ${limit + 1}
    `)
    const candidates: SynthesisCandidate[] = []
    const seenAnnotations = new Set<string>()
    let bytes = 0
    let nextCursor: SynthesisCandidateCursor | undefined
    for (const [index, row] of rows.slice(0, limit).entries()) {
      const binding = bindings.find((value) => value.documentId === row.documentId)
      const version = binding && versions.find((value) => value.id === binding.versionId)
      // The source rows are read in separate queries. A concurrent cleanup can remove the
      // binding/version between them; skip that stale row and let the next page continue.
      let candidate: SynthesisCandidate | undefined
      if (binding && version) {
        candidate = await this.resolve({
          annotationId: row.id,
          itemId: version.attachment.itemId,
          versionId: version.id
        })
      }
      const unique = candidate && !seenAnnotations.has(candidate.annotationId)
      const size = unique ? Buffer.byteLength(JSON.stringify(candidate)) : 0
      if (size > candidateResponseBudget - 1024)
        throw new Error('This annotation exceeds the candidate response size limit.')
      const rowCursor = { createdAt: row.createdAt.toISOString(), id: row.id }
      const count = candidates.length + (unique ? 1 : 0)
      const framing = Buffer.byteLength(
        JSON.stringify({
          action: 'candidates',
          candidates: [],
          ...(index + 1 < rows.length ? { nextCursor: rowCursor } : {})
        })
      )
      // Include the exact continuation and array separators; leave a row that did not fit eligible.
      if (bytes + size + Math.max(0, count - 1) + framing > candidateResponseBudget) {
        if (!candidates.length)
          throw new Error('This annotation exceeds the candidate response size limit.')
        return { candidates, nextCursor }
      }
      if (unique && candidate) {
        seenAnnotations.add(candidate.annotationId)
        bytes += size
        candidates.push(candidate)
      }
      // Advance past every examined row, including stale sources that did not resolve.
      nextCursor = rowCursor
    }
    return { candidates, ...(rows.length > limit ? { nextCursor } : {}) }
  }
}
