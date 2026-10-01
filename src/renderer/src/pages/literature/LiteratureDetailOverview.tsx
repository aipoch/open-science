import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import type { useFileDropZone } from '@/hooks/useFileDropZone'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { Download, FilePlus2, LoaderCircle, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureCollectionView,
  LiteratureItemType,
  LiteratureItemView
} from '../../../../shared/literature'
import { createLiteratureAttachmentVersionReference } from '../../../../shared/literature'
import type { SmartCollectionView } from '../../../../shared/literature-smart-collections'
import { ResourceTagSummary } from '../settings/ResourceTagControls'
import { LITERATURE_PREVIEW_SESSION_ID } from '../workspace/preview-file-item'
import { LiteratureAttachments } from './LiteratureAttachments'
import { LiteratureBibliographicDetails } from './LiteratureBibliographicDetails'
import type { LiteratureDetailController } from './LiteratureDetailController'
import { LiteratureDetailLinkList } from './LiteratureDetailLinkList'
import {
  SmartCollectionAssessment,
  SmartCollectionDecisionActions
} from './SmartCollectionDecision'
import { SmartRuleSummary } from './SmartRuleSummary'
import type { useLiteratureMetadata } from './useLiteratureMetadata'
import type { useLiteratureSmartReevaluation } from './useLiteratureSmartReevaluation'

export function LiteratureDetailOverview({
  selectedCollection,
  updateSmartEvidence,
  isBatching,
  smartTableBlocked,
  smartView,
  items,
  selectedItem,
  completedReevaluation,
  collectionId,
  singleReevaluation,
  prepareSmartReevaluation,
  pendingDecisions,
  smartRunningCollection,
  confirmSmartDecision,
  itemTypeLabels,
  handleDetailTagMenuOpenChange,
  activeProjects,
  projectLinkError,
  projectsLoaded,
  setProjectLink,
  displayCollections,
  collectionLinkError,
  setCollectionLink,
  changeDetailMode,
  isAddingPdf,
  pdfInputRef,
  addPdf,
  pdfError,
  detailController,
  setPreviewItem,
  pdfDropZoneProps,
  isDraggingPdf
}: {
  selectedCollection: LiteratureCollectionView | undefined
  updateSmartEvidence: () => Promise<void>
  isBatching: boolean
  smartTableBlocked: boolean
  smartView: SmartCollectionView | undefined
  items: LiteratureItemView[]
  selectedItem: LiteratureItemView
  completedReevaluation: ReturnType<typeof useLiteratureSmartReevaluation>['completedReevaluation']
  collectionId: string | undefined
  singleReevaluation: ReturnType<typeof useLiteratureSmartReevaluation>['singleReevaluation']
  prepareSmartReevaluation: (ids?: string[], detailItemId?: string) => Promise<void>
  pendingDecisions: Set<string>
  smartRunningCollection: string | undefined
  confirmSmartDecision: (
    decision: 'include' | 'exclude' | 'automatic',
    itemIds?: string[],
    singleRecord?: boolean
  ) => Promise<void>
  itemTypeLabels: Record<LiteratureItemType, string>
  handleDetailTagMenuOpenChange: (open: boolean) => void
  activeProjects: React.ComponentProps<typeof LiteratureDetailLinkList>['entries']
  projectLinkError: string | undefined
  projectsLoaded: boolean
  setProjectLink: (targetProjectId: string, included: boolean) => Promise<boolean>
  displayCollections: LiteratureCollectionView[]
  collectionLinkError: string | undefined
  setCollectionLink: (targetCollectionId: string, included: boolean) => Promise<boolean>
  changeDetailMode: ReturnType<typeof useLiteratureMetadata>['changeMode']
  isAddingPdf: boolean
  pdfInputRef: React.RefObject<HTMLInputElement | null>
  addPdf: (file: File) => Promise<void>
  pdfError: string | undefined
  detailController: LiteratureDetailController
  setPreviewItem: React.Dispatch<React.SetStateAction<PreviewFileItem | undefined>>
  pdfDropZoneProps: ReturnType<typeof useFileDropZone>['dropZoneProps']
  isDraggingPdf: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return (
    <div className="relative min-h-0 flex-1 divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
      {selectedCollection?.smart && (
        <section className="space-y-3 py-4">
          <h3 className="font-medium">{t('Collection decision')}</h3>
          <SmartRuleSummary rule={selectedCollection.description} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 max-w-full">
              <SmartCollectionAssessment
                inline
                onUpdate={() => void updateSmartEvidence()}
                updateDisabled={
                  isBatching ||
                  smartTableBlocked ||
                  !smartView?.configured ||
                  !smartView?.sourceAvailable
                }
                row={
                  items.find((item) => item.id === selectedItem.id)?.smartDecision ??
                  selectedItem.smartDecision
                }
              />
            </div>
            <SmartCollectionDecisionActions
              completed={
                completedReevaluation?.collectionId === collectionId &&
                completedReevaluation?.itemId === selectedItem.id
              }
              evaluating={
                singleReevaluation?.collectionId === collectionId &&
                singleReevaluation?.itemId === selectedItem.id
              }
              onReevaluate={() => void prepareSmartReevaluation([selectedItem.id])}
              row={
                items.find((item) => item.id === selectedItem.id)?.smartDecision ??
                selectedItem.smartDecision
              }
              disabled={
                isBatching ||
                pendingDecisions.has(`${collectionId}:${selectedItem.id}`) ||
                smartRunningCollection === collectionId
              }
              onDecision={(decision) =>
                void confirmSmartDecision(decision, [selectedItem.id], true)
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'Manual decisions are retained when the collection is updated. Use model decision restores automatic classification.'
            )}
          </p>
        </section>
      )}
      <LiteratureBibliographicDetails selectedItem={selectedItem} itemTypeLabels={itemTypeLabels} />
      <div className="py-4">
        <ResourceTagSummary
          reference={{
            resourceType: 'literature.item',
            resourceId: selectedItem.id
          }}
          onMenuOpenChange={handleDetailTagMenuOpenChange}
          keepMenuOpenOnSelect
        />
      </div>
      <div className="grid divide-y divide-border-300/80 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <section className="min-w-0 py-4 sm:pr-4">
          <h3 className="font-medium">{t('Projects')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Use this reference in projects.')}
          </p>
          <LiteratureDetailLinkList
            key={`${selectedItem.id}:projects`}
            checkedIds={selectedItem.projectIds}
            entries={activeProjects}
            error={projectLinkError}
            kind="projects"
            loaded={projectsLoaded}
            onCheckedChange={setProjectLink}
          />
        </section>
        <section className="py-4 sm:pl-4">
          <h3 className="font-medium">{t('Collections')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Use this reference in collections.')}
          </p>
          <LiteratureDetailLinkList
            key={`${selectedItem.id}:collections`}
            checkedIds={selectedItem.collectionIds}
            entries={displayCollections.filter((collection) => !collection.smart)}
            error={collectionLinkError}
            kind="collections"
            onCheckedChange={setCollectionLink}
          />
        </section>
      </div>
      <section className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">{t('Attachments')}</h3>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => changeDetailMode('full-text')}
          >
            <Download className="size-3.5" aria-hidden="true" />
            {t('Find full-text PDF')}
          </Button>
          {selectedItem.attachments.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAddingPdf}
              onClick={() => pdfInputRef.current?.click()}
            >
              {isAddingPdf ? (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <FilePlus2 className="size-3.5" aria-hidden="true" />
              )}
              {t('Add PDF')}
            </Button>
          ) : null}
          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            aria-label={t('Add PDF')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void addPdf(file)
            }}
          />
        </div>
        {pdfError ? (
          <p role="alert" className="mt-2 text-sm text-danger-000">
            {pdfError}
          </p>
        ) : null}
        <LiteratureAttachments
          readItem={detailController.read}
          key={selectedItem.id}
          item={selectedItem}
          onPreview={(version) => {
            const attachment = selectedItem.attachments.find((candidate) =>
              candidate.versions.some((candidateVersion) => candidateVersion.id === version.id)
            )
            if (!attachment) return
            setPreviewItem({
              id: `literature:${version.id}`,
              sessionId: LITERATURE_PREVIEW_SESSION_ID,
              title: version.filename,
              type: 'file',
              source: 'literature',
              managedFileId: attachment.id,
              path: createLiteratureAttachmentVersionReference(version.id),
              format: 'pdf',
              name: version.filename,
              mimeType: version.contentType,
              size: version.sizeBytes,
              versionNumber: version.versionNumber
            })
          }}
        />
        {selectedItem.attachments.length === 0 ? (
          <button
            type="button"
            data-slot="literature-pdf-drop-zone"
            {...pdfDropZoneProps}
            disabled={isAddingPdf}
            className="relative mt-2 flex w-full cursor-pointer flex-col items-center gap-2 overflow-hidden rounded-lg border border-dashed border-border bg-muted/20 px-6 py-8 text-center transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => pdfInputRef.current?.click()}
          >
            {isDraggingPdf ? (
              <FileDropOverlay label={t('Drop to upload')} className="rounded-lg" />
            ) : null}
            <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {isAddingPdf ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Upload className="size-4" aria-hidden="true" />
              )}
            </span>
            <span className="text-sm font-medium text-foreground">{t('Add PDF')}</span>
            <span className="text-xs text-muted-foreground">
              {t('Drag and drop or click to upload')}
            </span>
          </button>
        ) : null}
      </section>
    </div>
  )
}
