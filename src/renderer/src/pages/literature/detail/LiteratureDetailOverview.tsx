import { useLiteratureHost } from '../renderer-host'
import type { LiteraturePreviewItem } from '../renderer-host'
import { FileDropZone } from '@/components/FileDropZone'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import type { LiteratureItemType } from '@aipoch/literature-citations/contracts'
import type { LiteratureDetailController } from '@aipoch/literature-library/client'
import type {
  LiteratureCollectionView,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import type { SmartCollectionView } from '@aipoch/literature-screening/contracts'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { createLiteratureAttachmentVersionReference } from '../../../../../shared/literature-attachment-reference'
import { ResourceTagSummary } from '../../settings/ResourceTagControls'
import { LITERATURE_PREVIEW_SESSION_ID } from '../../../../../shared/literature-attachment-reference'
import {
  SmartCollectionAssessment,
  SmartCollectionDecisionActions
} from '../collections/SmartCollectionDecision'
import { SmartRuleSummary } from '../collections/SmartRuleSummary'
import type { useLiteratureSmartReevaluation } from '../collections/useLiteratureSmartReevaluation'
import type { useLiteratureMetadata } from '../workflows/useLiteratureMetadata'
import { LiteratureAttachments } from './LiteratureAttachments'
import { LiteratureBibliographicDetails } from './LiteratureBibliographicDetails'
import { LiteratureDetailLinkList } from './LiteratureDetailLinkList'

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
  addPdfs,
  pdfError,
  detailController,
  setPreviewItem,
  pdfProgress
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
  addPdfs: (files: File[]) => Promise<void>
  pdfError: string | undefined
  detailController: LiteratureDetailController
  setPreviewItem: React.Dispatch<React.SetStateAction<LiteraturePreviewItem | undefined>>
  pdfProgress: string | undefined
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { getPreviewFormatForFile } = useLiteratureHost()
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
            <Search className="size-3.5" aria-hidden="true" />
            {t('Find full-text PDF')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => changeDetailMode('supplements')}>
            <Search className="size-3.5" aria-hidden="true" />
            {t('Find supplementary materials')}
          </Button>
        </div>
        <FileDropZone
          key={selectedItem.id}
          data-slot="literature-pdf-drop-zone"
          className="mt-3"
          busy={isAddingPdf}
          onFiles={(files) => void addPdfs(files)}
          dropLabel={t('Drop files to attach to this reference')}
          picker={{
            label: t('Add files'),
            accept: '',
            description: t('Drop files here to attach to this reference, or choose files.'),
            multiple: true,
            inputRef: pdfInputRef
          }}
        >
          {pdfProgress ? (
            <p role="status" className="mt-2 break-words text-xs text-muted-foreground">
              {pdfProgress}
            </p>
          ) : null}
          {pdfError ? (
            <ErrorNotice inline role="alert" tone="amber" description={pdfError} />
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
                format: getPreviewFormatForFile({
                  name: version.filename,
                  mimeType: version.contentType
                }),
                name: version.filename,
                mimeType: version.contentType,
                size: version.sizeBytes,
                versionNumber: version.versionNumber
              })
            }}
          />
        </FileDropZone>
      </section>
    </div>
  )
}
