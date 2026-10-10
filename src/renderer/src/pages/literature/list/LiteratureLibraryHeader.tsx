import { useState } from 'react'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import type { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { ExternalLink, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCollectionView } from '../../../../../shared/literature'
import { LiteratureAddMenu, LiteratureLibraryActionsMenu } from './LiteratureLibraryMenus'
import { type LibrarySection } from './LiteratureLibrarySidebar'
import { type PdfImportDestination } from '../imports/LiteraturePdfBatchImportDialog'
import { LiteratureSearchInput } from './LiteratureSearchInput'

export function LiteratureLibraryHeader({
  selectedCollection,
  selectedProject,
  section,
  openProject,
  smartSetup,
  showLiteratureReviewAction,
  reviewProjectId,
  shouldCueLiteratureReview,
  startLiteratureReviewConversation,
  setShouldCueLiteratureReview,
  importPdfInputRef,
  setPdfBatch,
  projectId,
  collectionId,
  beginPdfImport,
  importRecordsInputRef,
  previewRecordImport,
  beginManualImport,
  query,
  searchResetRevision,
  setQuery,
  clearSelection,
  openEditCollection,
  setCollectionDeleteError,
  setCollectionPendingDelete,
  loadCollections,
  entriesLoading,
  projectItemCounts,
  exportCurrentScope
}: {
  selectedCollection: LiteratureCollectionView | undefined
  selectedProject: ReturnType<typeof useProjectStore.getState>['projects'][number] | undefined
  section: LibrarySection
  openProject: (projectId: string) => Promise<boolean>
  smartSetup: boolean
  showLiteratureReviewAction: boolean
  reviewProjectId: string | undefined
  shouldCueLiteratureReview: boolean
  startLiteratureReviewConversation: ReturnType<
    typeof useNavigationStore.getState
  >['startLiteratureReviewConversation']
  setShouldCueLiteratureReview: React.Dispatch<React.SetStateAction<boolean>>
  importPdfInputRef: React.RefObject<HTMLInputElement | null>
  setPdfBatch: React.Dispatch<
    React.SetStateAction<{ files: File[]; destination: PdfImportDestination } | undefined>
  >
  projectId: string | undefined
  collectionId: string | undefined
  beginPdfImport: (file: File) => void
  importRecordsInputRef: React.RefObject<HTMLInputElement | null>
  previewRecordImport: (file: File) => Promise<void>
  beginManualImport: (resetDraft?: boolean) => void
  query: string
  searchResetRevision: number
  setQuery: React.Dispatch<React.SetStateAction<string>>
  clearSelection: () => void
  openEditCollection: (collection: LiteratureCollectionView) => void
  setCollectionDeleteError: React.Dispatch<React.SetStateAction<string | undefined>>
  setCollectionPendingDelete: React.Dispatch<
    React.SetStateAction<LiteratureCollectionView | undefined>
  >
  loadCollections: () => Promise<LiteratureCollectionView[] | undefined>
  entriesLoading: boolean
  projectItemCounts: Record<string, number>
  exportCurrentScope: (format: 'bibtex' | 'ris') => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [projectEntryFailed, setProjectEntryFailed] = useState(false)
  return (
    <div
      className={
        selectedCollection?.smart ? 'hidden' : 'flex flex-wrap items-end justify-between gap-4'
      }
    >
      <div className="min-w-0 flex-1">
        {projectEntryFailed ? (
          <ErrorNotice
            inline
            tone="amber"
            description={t('Could not open this project. Please retry.')}
          />
        ) : null}
        <div className="flex w-fit max-w-full min-w-0 items-center gap-1.5">
          <h2
            className="min-w-0 truncate text-2xl font-semibold tracking-tight"
            title={selectedProject?.name ?? selectedCollection?.name}
          >
            {section === 'inbox'
              ? t('Inbox')
              : section === 'trash'
                ? t('Trash')
                : (selectedProject?.name ?? selectedCollection?.name ?? t('All references'))}
          </h2>
          {section === 'library' && selectedProject ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={t('Open project')}
              title={t('Open project')}
              onClick={() => {
                setProjectEntryFailed(false)
                void openProject(selectedProject.id).catch(() => setProjectEntryFailed(true))
              }}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {section === 'inbox'
            ? t('Review references found by Agents before they enter your library.')
            : section === 'trash'
              ? t(
                  'Restore references to edit, preview, or export them, or delete them permanently.'
                )
              : selectedProject
                ? t('References linked to this project.')
                : selectedCollection
                  ? (selectedCollection.smart
                      ? t('Smart collection')
                      : selectedCollection.description) || t('References saved in this collection.')
                  : t('Search and organize the references you use across projects.')}
        </p>
      </div>
      <div
        className={
          smartSetup
            ? 'hidden'
            : 'flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2 sm:w-auto'
        }
      >
        {showLiteratureReviewAction && reviewProjectId ? (
          <Button
            type="button"
            className="literature-review-cta h-8 shrink-0 px-1.5 pr-3 shadow-card hover:bg-primary/90 active:translate-y-px active:shadow-none dark:shadow-none [@media(pointer:coarse)]:h-11"
            data-attention={shouldCueLiteratureReview ? 'true' : undefined}
            onClick={() =>
              startLiteratureReviewConversation(
                reviewProjectId,
                selectedCollection
                  ? {
                      type: 'literature-scope',
                      scope: 'collection',
                      collectionId: selectedCollection.id,
                      name: selectedCollection.name
                    }
                  : { type: 'literature-scope', scope: 'project' },
                t('Synthesize this literature into a concise review.')
              )
            }
          >
            <span className="literature-review-cta__content inline-flex items-center gap-2">
              <span
                className="literature-review-cta__mark inline-grid size-6 place-items-center rounded-md bg-primary-foreground/15 ring-1 ring-primary-foreground/20 ring-inset"
                onAnimationEnd={() => setShouldCueLiteratureReview(false)}
              >
                <Sparkles className="size-3.5" aria-hidden="true" />
              </span>
              <span>{t('Review with agent')}</span>
            </span>
          </Button>
        ) : null}
        {section === 'library' && !selectedCollection?.smart ? (
          <div>
            <input
              ref={importPdfInputRef}
              multiple
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              aria-label={t('Import PDFs')}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                if (files.length > 1)
                  setPdfBatch({
                    files,
                    destination: {
                      name:
                        selectedProject?.name ?? selectedCollection?.name ?? t('All references'),
                      projectId,
                      collectionId
                    }
                  })
                else if (files[0]) beginPdfImport(files[0])
              }}
            />
            <input
              ref={importRecordsInputRef}
              type="file"
              accept=".bib,.bibtex,.ris,.nbib,.txt,application/x-bibtex,application/x-research-info-systems,text/plain"
              className="sr-only"
              aria-label={t('Import references')}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void previewRecordImport(file)
              }}
            />
            <LiteratureAddMenu
              onAddReference={() => beginManualImport(true)}
              onImportPdf={() => importPdfInputRef.current?.click()}
              onImportReferences={() => importRecordsInputRef.current?.click()}
            />
          </div>
        ) : null}
        <LiteratureSearchInput
          initialValue={query}
          resetRevision={searchResetRevision}
          onCommit={setQuery}
          onDraftChange={clearSelection}
        />
        {section === 'library' && (selectedProject || selectedCollection) ? (
          <LiteratureLibraryActionsMenu
            identityKey={selectedCollection?.id ?? selectedProject?.id ?? 'library'}
            onEdit={selectedCollection ? () => openEditCollection(selectedCollection) : undefined}
            onDelete={
              selectedCollection
                ? () => {
                    setCollectionDeleteError(undefined)
                    setCollectionPendingDelete(selectedCollection)
                    void loadCollections().catch(() =>
                      setCollectionDeleteError(t('Literature could not be loaded.'))
                    )
                  }
                : undefined
            }
            exportDisabled={
              entriesLoading ||
              (selectedProject
                ? projectItemCounts[selectedProject.id] === 0
                : selectedCollection?.itemCount === 0)
            }
            onExport={exportCurrentScope}
          />
        ) : null}
      </div>
    </div>
  )
}
