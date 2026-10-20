import { createHash } from 'node:crypto'
import type { PdfAnnotation as Row, PdfAnnotationImport } from '@prisma/client'
import { isDeepStrictEqual } from 'node:util'
import type {
  PdfAnnotationSource,
  PdfSharingPreview,
  PdfSharingDecision
} from '../../shared/pdf-annotations'
import { pdfNativeImportReceiptSchema } from '../../shared/pdf-annotations'
import type { PdfNativeAnnotationDraft } from './native-import-core'
import {
  bindingId,
  bindingSource,
  ensureBinding,
  touchDocument,
  type DocumentTransaction
} from './document-store'

const metadata = (
  row: Row,
  tags: readonly string[]
): { note: string; color: string | null; tagIds: string[] } => ({
  note: row.note,
  color: row.color,
  tagIds: [...tags].sort()
})
const receipt = (
  row: PdfAnnotationImport | null
): ReturnType<typeof pdfNativeImportReceiptSchema.parse> | undefined =>
  row ? pdfNativeImportReceiptSchema.parse(JSON.parse(row.resultJson)) : undefined
type Documents = { left: string; right: string }
const snapshot = async (
  tx: DocumentTransaction,
  source: PdfAnnotationSource,
  documentOverride?: string
): Promise<{
  binding: Awaited<ReturnType<typeof tx.pdfAnnotationSourceBinding.findUnique>>
  sources: Awaited<ReturnType<typeof tx.pdfAnnotationSourceBinding.findMany>>
  document: Awaited<ReturnType<typeof tx.pdfAnnotationDocument.findUnique>>
  rows: Row[]
  imported: PdfAnnotationImport | null
  tags: Awaited<ReturnType<typeof tx.tagAssignment.findMany>>
}> => {
  const binding = await tx.pdfAnnotationSourceBinding.findUnique({
    where: { id: bindingId(source) }
  })
  const documentId = documentOverride ?? binding?.documentId
  if (binding && binding.checksum !== source.checksum)
    throw new Error('PDF source content changed.')
  return {
    binding,
    document: documentId
      ? await tx.pdfAnnotationDocument.findUnique({ where: { id: documentId } })
      : null,
    sources: documentId
      ? await tx.pdfAnnotationSourceBinding.findMany({
          where: { documentId },
          orderBy: { id: 'asc' }
        })
      : [],
    rows: documentId
      ? await tx.pdfAnnotation.findMany({ where: { documentId }, orderBy: { id: 'asc' } })
      : [],
    imported: documentId
      ? await tx.pdfAnnotationImport.findUnique({ where: { documentId } })
      : null,
    tags: documentId
      ? await tx.tagAssignment.findMany({
          where: {
            resourceType: 'pdf.annotation',
            resourceId: {
              in: (
                await tx.pdfAnnotation.findMany({ where: { documentId }, select: { id: true } })
              ).map((row) => row.id)
            }
          },
          orderBy: [{ resourceId: 'asc' }, { tagId: 'asc' }]
        })
      : []
  }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
type Side = { row?: Row; deleted: boolean; modified: boolean }
type Pair = { key: string; left: Side; right: Side; choice?: PdfSharingDecision['choice'] }
const side = (state: Snapshot, draft: PdfNativeAnnotationDraft): Side => {
  const row = state.rows.find(
    (row) =>
      row.nativeKey === draft.stableKey ||
      (row.origin === 'imported' &&
        /^native:[a-f0-9]{32}:[a-f0-9]{64}$/.test(row.id) &&
        row.id.slice(-64) === draft.stableKey)
  )
  const imported = receipt(state.imported)
  const deleted =
    !row &&
    !!draft.nativeId &&
    !!imported?.nativeRefs.some(
      (ref) => ref.pageNumber === draft.pageNumber && ref.id === draft.nativeId
    )
  // A current parser draft is not evidence of the state stored by an older importer.
  // Preserve unknown legacy edits until the user has explicitly reviewed the merge.
  const baseline = row?.nativeBaselineJson ? JSON.parse(row.nativeBaselineJson) : undefined
  return {
    row,
    deleted,
    modified:
      !!row &&
      (!baseline ||
        !isDeepStrictEqual(
          metadata(
            row,
            state.tags.filter((tag) => tag.resourceId === row.id).map((tag) => tag.tagId)
          ),
          baseline
        ))
  }
}
const inspect = async (
  tx: DocumentTransaction,
  source: PdfAnnotationSource,
  target: PdfAnnotationSource,
  drafts: readonly PdfNativeAnnotationDraft[],
  context: string,
  documents?: Documents
): Promise<{ preview: PdfSharingPreview; left: Snapshot; right: Snapshot; pairs: Pair[] }> => {
  if (source.checksum !== target.checksum) throw new Error('PDF contents do not match.')
  const left = await snapshot(tx, source, documents?.left),
    right = await snapshot(tx, target, documents?.right)
  const shared = !!left.document && left.document.id === right.document?.id
  const pairs: Pair[] = shared
    ? []
    : drafts
        .map((draft) => {
          const l = side(left, draft),
            r = side(right, draft)
          let choice: Pair['choice']
          if (!l.row && !l.deleted) choice = 'right'
          else if (!r.row && !r.deleted) choice = 'left'
          else if (l.deleted && r.deleted) choice = 'delete'
          else if (l.deleted && !r.modified) choice = 'delete'
          else if (r.deleted && !l.modified) choice = 'delete'
          else if (l.row && r.row) {
            const lm = metadata(
              l.row,
              left.tags.filter((t) => t.resourceId === l.row!.id).map((t) => t.tagId)
            )
            const rm = metadata(
              r.row,
              right.tags.filter((t) => t.resourceId === r.row!.id).map((t) => t.tagId)
            )
            if (isDeepStrictEqual(lm, rm) || !r.modified) choice = 'left'
            else if (!l.modified) choice = 'right'
          }
          if ((l.row && !l.row.nativeBaselineJson) || (r.row && !r.row.nativeBaselineJson))
            choice = undefined
          return { key: draft.stableKey, left: l, right: r, choice }
        })
        .filter(
          (pair) => pair.left.row || pair.left.deleted || pair.right.row || pair.right.deleted
        )
  // Unknown historical identities remain separate; require explicit review before preserving them.
  for (const [label, state] of [
    ['left', left],
    ['right', right]
  ] as const)
    for (const row of state.rows) {
      if (
        shared ||
        row.origin !== 'imported' ||
        pairs.some((pair) => pair[label].row?.id === row.id)
      )
        continue
      pairs.push({
        key: `unknown:${row.id}`,
        left: { deleted: false, modified: true, ...(label === 'left' ? { row } : {}) },
        right: { deleted: false, modified: true, ...(label === 'right' ? { row } : {}) }
      })
    }
  const token = createHash('sha256')
    .update(
      JSON.stringify(
        { context, source: bindingId(source), checksum: source.checksum, left, right, drafts },
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
      )
    )
    .digest('hex')
  const view = (value: Side, state: Snapshot): PdfSharingPreview['conflicts'][number]['left'] => {
    if (!value.row) return null
    const selector = JSON.parse(value.row.selectorJson).selector
    return {
      id: value.row.id,
      note: value.row.note,
      color: value.row.color ?? undefined,
      tagIds: state.tags.filter((tag) => tag.resourceId === value.row!.id).map((tag) => tag.tagId),
      quote: selector.exact ?? selector.text ?? '',
      pageNumber: selector.pageNumber
    }
  }

  return {
    left,
    right,
    pairs,
    preview: {
      token,
      shared,
      sourceCount: new Set([...left.sources, ...right.sources].map((s) => s.id)).size,
      annotationCount: left.rows.length + (shared ? 0 : right.rows.length),
      sources: [
        ...new Map(
          [...left.sources, ...right.sources].map((s) => [s.id, bindingSource(s)])
        ).values()
      ],
      conflicts: pairs
        .filter((p) => !p.choice)
        .map((p) => ({
          key: p.key,
          left: view(p.left, left),
          right: view(p.right, right),
          unknown:
            p.key.startsWith('unknown:') ||
            !!(p.left.row && !p.left.row.nativeBaselineJson) ||
            !!(p.right.row && !p.right.row.nativeBaselineJson)
        }))
    }
  }
}
export const previewSharing = async (
  tx: DocumentTransaction,
  source: PdfAnnotationSource,
  target: PdfAnnotationSource,
  drafts: readonly PdfNativeAnnotationDraft[],
  context: string,
  documents?: Documents
): Promise<PdfSharingPreview> =>
  (await inspect(tx, source, target, drafts, context, documents)).preview

export const commitSharing = async (
  tx: DocumentTransaction,
  source: PdfAnnotationSource,
  target: PdfAnnotationSource,
  sizeBytes: number,
  drafts: readonly PdfNativeAnnotationDraft[],
  context: string,
  token: string,
  decisions: readonly PdfSharingDecision[],
  documents?: Documents
): Promise<void> => {
  const inspection = await inspect(tx, source, target, drafts, context, documents)
  if (inspection.preview.token !== token)
    throw new Error('PDF sharing preview expired. Review the current notes again.')
  if (inspection.preview.shared) return
  const choices = new Map(decisions.map((decision) => [decision.key, decision.choice]))
  if (
    choices.size !== decisions.length ||
    [...choices.keys()].some((key) => !inspection.preview.conflicts.some((c) => c.key === key))
  )
    throw new Error('Invalid PDF sharing decisions.')
  for (const pair of inspection.pairs) {
    pair.choice ??= choices.get(pair.key)
    if (!pair.choice) throw new Error('Resolve every PDF sharing conflict before continuing.')
    if (
      (pair.choice === 'both' && (!pair.left.row || !pair.right.row)) ||
      (choices.get(pair.key) === 'left' && !pair.left.row) ||
      (choices.get(pair.key) === 'right' && !pair.right.row)
    )
      throw new Error('Invalid PDF sharing decisions.')
  }
  const l = documents ? { documentId: documents.left } : await ensureBinding(tx, source),
    r = documents ? { documentId: documents.right } : await ensureBinding(tx, target)
  const documentId = l.documentId
  for (const pair of inspection.pairs) {
    const lrow = pair.left.row,
      rrow = pair.right.row
    const keep = pair.choice === 'left' ? lrow : pair.choice === 'right' ? rrow : undefined
    for (const row of [lrow, rrow]) {
      if (!row) continue
      if (pair.choice === 'both') {
        await tx.pdfAnnotation.update({
          where: { id: row.id },
          data: { nativeKey: null, nativeBaselineJson: null, origin: 'user', externalSubtype: null }
        })
        continue
      }
      if (row.id === keep?.id) continue
      await tx.tagAssignment.deleteMany({
        where: { resourceType: 'pdf.annotation', resourceId: row.id }
      })
      await tx.pdfAnnotationAlias.updateMany({
        where: { annotationId: row.id },
        data: { annotationId: keep?.id ?? null }
      })
      await tx.pdfAnnotationAlias.upsert({
        where: { id: row.id },
        create: { id: row.id, documentId, annotationId: keep?.id ?? null },
        update: { documentId, annotationId: keep?.id ?? null }
      })
      await tx.pdfAnnotation.delete({ where: { id: row.id } })
    }
  }
  // Imports suppress originals even when all their corresponding notes were deleted.
  const receipts = [inspection.left.imported, inspection.right.imported].filter(
    (v): v is PdfAnnotationImport => !!v
  )
  if (receipts.length > 1) {
    const values = receipts.map((row) => receipt(row)!)
    const merged = {
      nativeRefs: [
        ...new Map(
          values.flatMap((v) => v.nativeRefs).map((ref) => [`${ref.pageNumber}:${ref.id}`, ref])
        ).values()
      ],
      pageCount: Math.max(...values.map((v) => v.pageCount)),
      unsupportedCount: Math.max(...values.map((v) => v.unsupportedCount)),
      truncated: values.some((v) => v.truncated)
    }
    pdfNativeImportReceiptSchema.parse(merged)
    await tx.pdfAnnotationImport.delete({ where: { id: receipts[1].id } })
    await tx.pdfAnnotationImport.update({
      where: { id: receipts[0].id },
      data: { resultJson: JSON.stringify(merged), documentId }
    })
  } else if (receipts[0])
    await tx.pdfAnnotationImport.update({ where: { id: receipts[0].id }, data: { documentId } })
  await tx.pdfAnnotation.updateMany({ where: { documentId: r.documentId }, data: { documentId } })
  // Mark every surviving row changed: stale edits/undo from either source must fail after a merge.
  const survivors = await tx.pdfAnnotation.findMany({
    where: { documentId },
    select: { id: true, updatedAt: true }
  })
  await tx.pdfAnnotation.updateMany({
    where: { documentId },
    data: {
      updatedAt: new Date(
        survivors.reduce((stamp, row) => Math.max(stamp, row.updatedAt.getTime() + 1), Date.now())
      )
    }
  })
  await tx.pdfAnnotationAlias.updateMany({
    where: { documentId: r.documentId },
    data: { documentId }
  })
  await tx.pdfAnnotationSourceBinding.updateMany({
    where: { documentId: r.documentId },
    data: { documentId }
  })
  await tx.pdfAnnotationDocument.update({
    where: { id: documentId },
    data: { sizeBytes: BigInt(sizeBytes) }
  })
  await touchDocument(tx, documentId)
  if (r.documentId !== documentId)
    await tx.pdfAnnotationDocument.delete({ where: { id: r.documentId } })
}
