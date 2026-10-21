import { useLiteratureHost } from '../renderer-host'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { createLiteratureCreation } from '@aipoch/literature-library/client'
import { LITERATURE_IMPORT_IDENTITY_CONFLICT } from '@aipoch/literature-library/contracts'
import type { TFunction } from 'i18next'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'
import { useLiteraturePdfStaging } from './useLiteraturePdfStaging'

import { LITERATURE_RECORD_IMPORT_MAX_BYTES } from '@aipoch/literature-citations/contracts'
import type {
  LiteratureCollectionView,
  LiteratureDuplicatePolicy,
  LiteratureItemView,
  LiteratureRecordImportResult
} from '@aipoch/literature-library/contracts'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'

import { type LiteratureDetailController } from '@aipoch/literature-library/client'
import { formatUploadSizeLimit } from '../../../../../shared/uploads'
import { stageUploadFile as stageComposerFile } from '@/lib/upload-transfer'
import { type RecordImportDraft } from './LiteratureRecordImportDialog'

const LITERATURE_BATCH_COMMAND_SIZE = 200
export const pdfImportErrorMessage = (error: unknown, t: TFunction): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('[pdf-password]'))
    return t('This PDF requires a password. Add an unlocked copy.')
  if (message.includes('[pdf-invalid]'))
    return t('This PDF is damaged or invalid. Select another file.')
  if (message.includes('[pdf-unreadable]'))
    return t(
      'This PDF could not be parsed. It may use unsupported features. Select another file or try again.'
    )
  return t('PDF could not be added.')
}

export const emptyLiteratureItem = (): LiteratureItemInput => ({
  itemType: 'journalArticle',
  title: '',
  abstract: '',
  issuedText: '',
  containerTitle: '',
  shortTitle: '',
  language: '',
  rights: '',
  url: '',
  extra: '',
  typeFields: {},
  creators: [],
  identifiers: []
})

export const titleFromPdfFilename = (filename: string): string =>
  filename
    .replace(/\.pdf$/iu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || filename

/** Own creation receipts and destinations across retries, including optional PDF attachment. */
export function useLiteratureImport({
  projectId,
  collectionId,
  selectedProject,
  selectedCollection,
  detailController,
  pdfStaging,
  setItems,
  loadEntries,
  loadCollections,
  loadProjectCounts,
  openSelectedItemDetail,
  setPdfError,
  requestMetadataExit
}: {
  projectId?: string
  collectionId?: string
  selectedProject?: { name: string }
  selectedCollection?: LiteratureCollectionView
  detailController: LiteratureDetailController
  pdfStaging: ReturnType<typeof useLiteraturePdfStaging>
  setItems: React.Dispatch<React.SetStateAction<LiteratureItemView[]>>
  loadEntries: (force?: boolean) => Promise<unknown>
  loadCollections: () => Promise<unknown>
  loadProjectCounts: () => Promise<void>
  openSelectedItemDetail: (item: LiteratureItemView) => void
  setPdfError: (message: string) => void
  requestMetadataExit: (dirty: boolean, action: () => void) => void
}): {
  isCreatingItem: boolean
  isSavingNewItem: boolean
  createdItemId: string | undefined
  dialogItemEditor:
    | {
        file: File | PdfAnnotationSource | undefined
        draft: LiteratureItemInput | undefined
        metadataNotice: string | undefined
        reading: boolean
        error: string | undefined
        duplicatePolicy: LiteratureDuplicatePolicy
        createdItemId: string | undefined
      }
    | undefined
  recordImport:
    | (RecordImportDraft & {
        destination: { name: string; projectId?: string; collectionId?: string }
      })
    | undefined
  duplicatePolicy: LiteratureDuplicatePolicy
  setDuplicatePolicy: React.Dispatch<React.SetStateAction<LiteratureDuplicatePolicy>>
  isImportingRecords: boolean
  createManualItem: (item?: LiteratureItemInput) => Promise<void>
  beginPdfImport: (file: File | PdfAnnotationSource) => void
  closeItemEditor: () => void
  previewRecordImport: (file: File) => Promise<void>
  previewRecordSelection: (
    content: string,
    selectedItemIndexes: number[]
  ) => Promise<LiteratureRecordImportResult>
  commitRecordImport: (selectedItemIndexes?: number[]) => Promise<void>
  trackNewMetadataDirty: (dirty: boolean) => void
  beginManualImport: (resetDraft?: boolean) => void
  closeRecordImport: () => void
} {
  const host = useLiteratureHost()
  const { api: hostApi } = host

  const { t } = useTranslation()
  const [isCreatingItem, setIsCreatingItem] = useState(false)
  const [isSavingNewItem, setIsSavingNewItem] = useState(false)
  const [createItemError, setCreateItemError] = useState<string>()
  const [createdItemId, setCreatedItemId] = useState<string>()
  const creatingItemRef = useRef(false)
  const [detailReader] = useState(() => {
    let latest = detailController
    return {
      update: (next: LiteratureDetailController): void => {
        latest = next
      },
      read: (id: string): Promise<LiteratureItemView | undefined> => latest.read(id)
    }
  })
  useLayoutEffect(() => {
    detailReader.update(detailController)
  }, [detailController, detailReader])
  const [creation] = useState(() =>
    createLiteratureCreation<File | PdfAnnotationSource>({
      transact: (command) => hostApi.literature.transact(command),
      read: detailReader.read,
      onCreated: setCreatedItemId
    })
  )
  const [pendingImportPdf, setPendingImportPdf] = useState<File | PdfAnnotationSource>()
  const [pendingImportMetadataNotice, setPendingImportMetadataNotice] = useState<string>()
  const [pendingImportDraft, setPendingImportDraft] = useState<LiteratureItemInput>()
  const [isReadingImportMetadata, setIsReadingImportMetadata] = useState(false)
  const [recordImport, setRecordImport] = useState<
    RecordImportDraft & { destination: { name: string; projectId?: string; collectionId?: string } }
  >()
  const [duplicatePolicy, setDuplicatePolicy] = useState<LiteratureDuplicatePolicy>('reuse')
  const dialogItemEditor = useRetainedDialogValue(
    useMemo(
      () =>
        isCreatingItem
          ? {
              file: pendingImportPdf,
              draft: pendingImportDraft,
              metadataNotice: pendingImportMetadataNotice,
              reading: isReadingImportMetadata,
              error: createItemError,
              duplicatePolicy,
              createdItemId
            }
          : undefined,
      [
        isCreatingItem,
        pendingImportPdf,
        pendingImportDraft,
        pendingImportMetadataNotice,
        isReadingImportMetadata,
        createItemError,
        duplicatePolicy,
        createdItemId
      ]
    )
  )
  const recordImportRequest = useRef(0)

  const [isImportingRecords, setIsImportingRecords] = useState(false)
  const importingRecordsRef = useRef(false)
  const importMetadataGenerationRef = useRef(0)
  const newMetadataDirtyRef = useRef(false)
  const trackNewMetadataDirty = useCallback((dirty: boolean) => {
    newMetadataDirtyRef.current = dirty
  }, [])
  const createManualItem = async (item?: LiteratureItemInput): Promise<void> => {
    if (creatingItemRef.current || (!creation.pendingId && !item)) return
    creatingItemRef.current = true
    setIsSavingNewItem(true)
    setCreateItemError(undefined)
    const transferId = crypto.randomUUID()
    let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
    try {
      const result = await creation.complete(
        {
          item,
          duplicatePolicy,
          projectId,
          collectionId,
          smartCollection: Boolean(selectedCollection?.smart),
          file: pendingImportPdf
        },
        async (file, itemId) => {
          if ('kind' in file)
            return (
              await hostApi.literature.addPdf({ source: file, itemId, operationId: transferId })
            ).item
          staged = await pdfStaging.stagePdf(file, transferId)
          await hostApi.uploads.claimLocalFile?.({ transferId })
          pdfStaging.finishPdfStaging()
          const operationId = crypto.randomUUID()
          pdfStaging.trackNativeImport(operationId)
          const result = await hostApi.literature.importPdf({
            itemId,
            attachment: staged,
            operationId
          })
          pdfStaging.trackNativeImport(undefined)
          return result.item
        }
      )
      const created = result.item
      setItems((entries) =>
        entries.some((entry) => entry.id === created.id)
          ? entries.map((entry) => (entry.id === created.id ? created : entry))
          : [created, ...entries]
      )
      if (result.collectionId) await loadCollections()
      if (result.projectId) await loadProjectCounts()
      resetItemEditor()
      openSelectedItemDetail(created)
    } catch (error) {
      setCreatedItemId(creation.pendingId)
      const created = await creation.recoverPdfFailure()
      if (created) {
        resetItemEditor()
        openSelectedItemDetail(created)
        setPdfError(
          pdfStaging.wasCancelled()
            ? t('PDF upload cancelled. The reference was kept.')
            : pdfImportErrorMessage(error, t)
        )
      } else {
        setCreateItemError(
          creation.failurePhase !== 'create'
            ? creation.failurePhase === 'destination'
              ? t(
                  'The reference was created, but linking it to the destination failed. Retry to finish linking. Closing leaves it in your library without that link.'
                )
              : t(
                  'The reference was created, but the remaining steps failed. Retry to finish. If you close, the reference remains in your library.'
                )
            : t('Literature could not be created.')
        )
      }
    } finally {
      if (staged) await hostApi.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
      void loadEntries(true)
      pdfStaging.clear()
      creatingItemRef.current = false
      setIsSavingNewItem(false)
    }
  }

  const beginPdfImport = (file: File | PdfAnnotationSource): void => {
    setDuplicatePolicy('reuse')
    const fallback = { ...emptyLiteratureItem(), title: titleFromPdfFilename(file.name) }
    const generation = ++importMetadataGenerationRef.current
    setPendingImportPdf(file)
    setPendingImportDraft(fallback)
    setPendingImportMetadataNotice(undefined)
    setCreateItemError(undefined)
    setIsReadingImportMetadata(true)
    setIsCreatingItem(true)
    void import('./literature-pdf-metadata')
      .then(
        async ({
          extractLiteraturePdfDraft,
          completeLiteraturePdfDraft,
          pdfMetadataNoticeLabel
        }) => {
          const notice = (value: Parameters<typeof pdfMetadataNoticeLabel>[0]): void => {
            if (importMetadataGenerationRef.current === generation)
              setPendingImportMetadataNotice(pdfMetadataNoticeLabel(value, t))
          }
          const local = await extractLiteraturePdfDraft(host, file, fallback, notice)
          if (importMetadataGenerationRef.current !== generation) return local
          return completeLiteraturePdfDraft(hostApi, local, notice)
        }
      )
      .then((draft) => {
        if (importMetadataGenerationRef.current === generation) setPendingImportDraft(draft)
      })
      .catch(() => {
        if (importMetadataGenerationRef.current === generation)
          setPendingImportMetadataNotice(
            t(
              'PDF text could not be read. For scanned pages, use a searchable PDF. Review the metadata before importing.'
            )
          )
      })
      .finally(() => {
        if (importMetadataGenerationRef.current === generation) setIsReadingImportMetadata(false)
      })
  }

  const resetItemEditor = (): void => {
    creation.reset()
    setCreatedItemId(undefined)
    setDuplicatePolicy('reuse')
    importMetadataGenerationRef.current += 1
    setIsCreatingItem(false)
    setPendingImportPdf(undefined)
    setPendingImportDraft(undefined)
    setIsReadingImportMetadata(false)
    setCreateItemError(undefined)
  }

  const closeItemEditor = (): void => {
    if (creatingItemRef.current) return
    requestMetadataExit(newMetadataDirtyRef.current && !createdItemId, resetItemEditor)
  }

  const previewRecordImport = async (file: File): Promise<void> => {
    setDuplicatePolicy('reuse')
    const request = ++recordImportRequest.current
    const destination = {
      name: selectedProject?.name ?? selectedCollection?.name ?? t('All references'),
      projectId,
      collectionId
    }
    setRecordImport({ fileName: file.name, content: '', reading: true, destination })
    if (file.size > LITERATURE_RECORD_IMPORT_MAX_BYTES) {
      setRecordImport({
        destination,
        fileName: file.name,
        content: '',
        error: t('{{fileName}}: file is too large (limit {{limit}}).', {
          fileName: file.name,
          limit: formatUploadSizeLimit(LITERATURE_RECORD_IMPORT_MAX_BYTES)
        })
      })
      return
    }
    try {
      const content = await file.text()
      if (request !== recordImportRequest.current) return
      setRecordImport({ fileName: file.name, content, destination })
      const preview = await hostApi.literature.importRecords({ mode: 'preview', content })
      if (request !== recordImportRequest.current) return
      setRecordImport({ fileName: file.name, content, preview, destination })
    } catch {
      if (request !== recordImportRequest.current) return
      setRecordImport({
        destination,
        fileName: file.name,
        content: '',
        error: t('Reference file could not be read.')
      })
    }
  }

  const previewRecordSelection = useCallback(
    (content: string, selectedItemIndexes: number[]): Promise<LiteratureRecordImportResult> =>
      hostApi.literature.importRecords({ mode: 'preview', content, selectedItemIndexes }),
    [hostApi]
  )

  const commitRecordImport = async (selectedItemIndexes?: number[]): Promise<void> => {
    if (
      importingRecordsRef.current ||
      !recordImport?.preview ||
      recordImport.preview.items.length === 0
    )
      return
    importingRecordsRef.current = true
    const { projectId, collectionId } = recordImport.destination
    setIsImportingRecords(true)
    setRecordImport((current) =>
      current ? { ...current, error: undefined, failedCount: undefined } : current
    )
    try {
      const imported = await hostApi.literature.importRecords({
        mode: 'commit',
        content: recordImport.content,
        ...(selectedItemIndexes ? { selectedItemIndexes } : {}),
        ...(duplicatePolicy === 'reuse' ? {} : { duplicatePolicy }),
        ...(collectionId ? { collectionId } : {})
      })
      setRecordImport((current) =>
        current
          ? {
              ...current,
              preview: {
                ...imported,
                entries: current.preview!.entries.map(
                  (entry) => imported.entries.find((next) => next.index === entry.index) ?? entry
                )
              }
            }
          : current
      )
      if (projectId && imported.imported?.itemIds.length) {
        for (
          let offset = 0;
          offset < imported.imported.itemIds.length;
          offset += LITERATURE_BATCH_COMMAND_SIZE
        ) {
          await hostApi.literature.transact({
            kind: 'set-project-items',
            projectId,
            itemIds: imported.imported.itemIds.slice(
              offset,
              offset + LITERATURE_BATCH_COMMAND_SIZE
            ),
            included: true,
            source: 'library'
          })
        }
      }
      await Promise.all([
        loadEntries(true),
        loadCollections(),
        ...(projectId ? [loadProjectCounts()] : [])
      ])
    } catch (error) {
      if (error instanceof Error && error.message.includes(LITERATURE_IMPORT_IDENTITY_CONFLICT)) {
        const preview = await hostApi.literature
          .importRecords({
            mode: 'preview',
            content: recordImport.content,
            ...(selectedItemIndexes ? { selectedItemIndexes } : {})
          })
          .catch(() => undefined)
        setRecordImport((current) =>
          current
            ? {
                ...current,
                ...(preview
                  ? {
                      preview: {
                        ...preview,
                        entries: current.preview!.entries.map(
                          (entry) =>
                            preview.entries.find((next) => next.index === entry.index) ?? entry
                        )
                      }
                    }
                  : {}),
                error: t(
                  'Some identifiers disagree or match different references. Exclude conflicting references, correct the source file, or keep separate copies of the selected references.'
                )
              }
            : current
        )
        return
      }
      setRecordImport((current) =>
        current
          ? {
              ...current,
              error: current.preview?.imported
                ? t(
                    'References were saved, but the destination could not be updated. You can find them in All references.'
                  )
                : t('Reference import failed. Please try again.'),
              failedCount: current.preview?.imported
                ? 0
                : (selectedItemIndexes?.length ?? current.preview?.items.length ?? 0)
            }
          : current
      )
    } finally {
      importingRecordsRef.current = false
      setIsImportingRecords(false)
    }
  }

  const beginManualImport = (resetDraft = false): void => {
    if (resetDraft) {
      setPendingImportPdf(undefined)
      setPendingImportDraft(undefined)
      setIsReadingImportMetadata(false)
      setCreateItemError(undefined)
    }
    setDuplicatePolicy('reuse')
    setIsCreatingItem(true)
  }
  const closeRecordImport = (): void => {
    if (importingRecordsRef.current) return
    recordImportRequest.current += 1
    setRecordImport(undefined)
  }
  return {
    isCreatingItem,
    isSavingNewItem,
    createdItemId,
    dialogItemEditor,
    recordImport,
    duplicatePolicy,
    setDuplicatePolicy,
    isImportingRecords,
    createManualItem,
    beginPdfImport,
    closeItemEditor,
    previewRecordImport,
    previewRecordSelection,
    commitRecordImport,
    trackNewMetadataDirty,
    beginManualImport,
    closeRecordImport
  }
}
