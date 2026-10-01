import {
  BookOpenText,
  ChevronDown,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { memo, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { JournalAttributes } from '../JournalAttributes'
import { LiteratureRowNumbers } from './literature-row-numbers'
import {
  SmartCollectionCells,
  type SmartCollectionCellActions
} from '../collections/SmartCollectionDecision'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNavigationStore } from '@/stores/navigation-store'
import type {
  LiteratureItemInput,
  LiteratureItemType,
  LiteratureItemView
} from '../../../../../shared/literature'
import { ResourceTagBadges, ResourceTagMenu } from '../../settings/ResourceTagControls'
import { LiteratureSelectionStore } from './literature-selection'
import { LiteratureSelectionCheckbox } from './LiteratureSelection'
import { LiteratureTextTooltip } from '../LiteratureTable'

import { LiteratureTableColumn } from './literature-table-preferences'

import {
  LiteratureNoteControl,
  LiteratureRatingControl,
  LiteratureTypeControl
} from './LiteratureInlineEditors'

import {
  creatorLabel,
  fullCreatorLabel,
  getExternalLiteratureUrl
} from '../literature-item-display'

export type LiteratureRowActions = {
  openSelectedItemDetail: (entry: LiteratureItemView, initiator?: HTMLElement) => void
  persistInlineItem: (
    entry: LiteratureItemView,
    patch: Partial<Pick<LiteratureItemInput, 'itemType' | 'personalNote' | 'rating'>>,
    onPersisted?: (reload: () => Promise<LiteratureItemView>) => void
  ) => Promise<void>
  previewFirstAttachment: (entry: LiteratureItemView) => void
  setItemsLifecycle: (
    ids: readonly string[] | undefined,
    state: 'active' | 'deleted'
  ) => Promise<void>
  requestPermanentDeletion: (ids: string[]) => void
}

function LiteratureRowNumber({ itemId }: { itemId: string }): React.JSX.Element {
  const number = useContext(LiteratureRowNumbers).get(itemId)
  return (
    <td
      data-row-number={number}
      className="px-2 py-2 text-center align-middle text-xs tabular-nums text-muted-foreground"
    >
      {number}
    </td>
  )
}

// Render inputs are explicit; event handlers read the latest owner guards at interaction time.
export const LiteratureItemRow = memo(function LiteratureItemRow({
  entry,
  trash,
  smart,
  smartTableBlocked,
  isBatching,
  decisionDisabled,
  updateDisabled,
  completed,
  evaluating,
  attachmentPending,
  selectionStore,
  smartCellActions,
  visibleOrderedTableColumns,
  itemTypeLabels,
  ratingLabels,
  actions
}: {
  entry: LiteratureItemView
  trash: boolean
  smart: boolean
  smartTableBlocked: boolean
  isBatching: boolean
  decisionDisabled: boolean
  updateDisabled: boolean
  completed: boolean
  evaluating: boolean
  attachmentPending: boolean
  selectionStore: LiteratureSelectionStore
  smartCellActions: React.RefObject<SmartCollectionCellActions>
  visibleOrderedTableColumns: LiteratureTableColumn[]
  itemTypeLabels: Record<LiteratureItemType, string>
  ratingLabels: readonly string[]
  actions: React.RefObject<LiteratureRowActions>
}): React.JSX.Element {
  const { t } = useTranslation()
  const attachmentVersion = entry.attachments.find((attachment) => attachment.versions[0])
    ?.versions[0]
  const hasUnavailableAttachment = entry.attachments.some((attachment) =>
    attachment.versions.some((version) => version.availability === 'unavailable')
  )
  return (
    <tr className="group h-16 bg-bg-000 hover:bg-bg-200 focus-within:bg-bg-200">
      <td className="px-3 py-2 align-middle">
        <LiteratureSelectionCheckbox
          disabled={smartTableBlocked}
          itemId={entry.id}
          label={t('Select {{title}}', { title: entry.item.title })}
          store={selectionStore}
          className="size-4"
        />
      </td>
      <LiteratureRowNumber itemId={entry.id} />
      <td className="p-0 align-middle">
        <LiteratureTextTooltip text={entry.item.title}>
          <button
            type="button"
            className="flex h-full min-h-16 w-full min-w-0 items-center gap-2 px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            disabled={trash}
            onClick={(event) => actions.current.openSelectedItemDetail(entry, event.currentTarget)}
          >
            <span className="min-w-0 line-clamp-2 break-words font-medium text-foreground">
              {entry.item.title}
            </span>
            {entry.mergedIntoItemId ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('Merged duplicate')}
              </span>
            ) : null}
          </button>
        </LiteratureTextTooltip>
      </td>
      {smart && (
        <SmartCollectionCells
          itemId={entry.id}
          row={entry.smartDecision}
          actions={smartCellActions}
          completed={completed}
          evaluating={evaluating}
          disabled={decisionDisabled}
          updateDisabled={updateDisabled}
        />
      )}
      {visibleOrderedTableColumns.map((column) => {
        if (column.startsWith('journal:'))
          return (
            <td
              key={column}
              className="w-[180px] min-w-[180px] max-w-[180px] overflow-hidden px-2 py-2 align-middle"
            >
              <JournalAttributes item={entry.item} itemId={entry.id} fieldKey={column.slice(8)} />
            </td>
          )
        switch (column) {
          case 'abstract':
            return (
              <LiteratureTextTooltip key={column} text={entry.item.abstract}>
                <td
                  tabIndex={entry.item.abstract ? 0 : undefined}
                  className="px-3 py-2 align-middle text-muted-foreground"
                >
                  <span className="line-clamp-2 leading-5">{entry.item.abstract || '—'}</span>
                </td>
              </LiteratureTextTooltip>
            )
          case 'year':
            return (
              <td
                key={column}
                className="px-3 py-2 align-middle text-muted-foreground tabular-nums"
              >
                {entry.item.issuedYear ?? '—'}
              </td>
            )
          case 'publication':
            return (
              <LiteratureTextTooltip key={column} text={entry.item.containerTitle}>
                <td
                  tabIndex={entry.item.containerTitle ? 0 : undefined}
                  className="truncate px-3 py-2 align-middle text-muted-foreground"
                >
                  {entry.item.containerTitle || '—'}
                </td>
              </LiteratureTextTooltip>
            )
          case 'authors':
            return (
              <LiteratureTextTooltip key={column} text={fullCreatorLabel(entry.item)}>
                <td
                  tabIndex={entry.item.creators.length ? 0 : undefined}
                  className="truncate px-3 py-2 align-middle text-muted-foreground"
                >
                  {creatorLabel(entry.item) || t('Unknown')}
                </td>
              </LiteratureTextTooltip>
            )
          case 'type':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <LiteratureTypeControl
                  disabled={trash || smartTableBlocked}
                  key={`${entry.id}:${entry.metadataRevision}:type`}
                  value={entry.item.itemType}
                  title={entry.item.title}
                  labels={itemTypeLabels}
                  onCommit={(itemType) => actions.current.persistInlineItem(entry, { itemType })}
                />
              </td>
            )
          case 'tags':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <ResourceTagMenu
                  reference={{
                    resourceType: 'literature.item',
                    resourceId: entry.id
                  }}
                  trigger={
                    <button
                      type="button"
                      aria-label={t('Manage Tags')}
                      disabled={trash || smartTableBlocked}
                      className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">
                        <ResourceTagBadges
                          reference={{
                            resourceType: 'literature.item',
                            resourceId: entry.id
                          }}
                          removable={false}
                          className="min-w-0 justify-start"
                        />
                      </span>
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  }
                />
              </td>
            )
          case 'rating':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <LiteratureRatingControl
                  labels={ratingLabels}
                  disabled={trash || smartTableBlocked}
                  key={`${entry.id}:${entry.metadataRevision}:rating`}
                  value={entry.item.rating ?? 0}
                  onCommit={(rating) => actions.current.persistInlineItem(entry, { rating })}
                />
              </td>
            )
          case 'notes':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <LiteratureNoteControl
                  disabled={trash || smartTableBlocked}
                  key={entry.id}
                  entry={entry}
                  onCommit={(base, personalNote, onPersisted) =>
                    actions.current.persistInlineItem(base, { personalNote }, onPersisted)
                  }
                />
              </td>
            )
          case 'url': {
            const externalUrl = getExternalLiteratureUrl(entry.item.url)
            return (
              <td key={column} className="px-2 py-2 text-center align-middle text-muted-foreground">
                {externalUrl ? (
                  <ExternalTextLink
                    href={externalUrl.href}
                    aria-label={`${t('URL')}: ${externalUrl.href}`}
                    className="size-8 justify-center rounded-md no-underline hover:bg-muted"
                  >
                    <span className="sr-only">{externalUrl.href}</span>
                  </ExternalTextLink>
                ) : (
                  '—'
                )}
              </td>
            )
          }
          default:
            return null
        }
      })}
      <td className="sticky right-12 z-20 w-28 min-w-28 max-w-28 border-l border-transparent bg-inherit group-data-[overflow-right=true]/journal-scroll:border-border-300/60 px-3 py-2 text-center align-middle before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-linear-to-l before:from-foreground/5 before:to-transparent before:opacity-0 group-data-[overflow-right=true]/journal-scroll:before:opacity-100">
        {attachmentVersion ? (
          <LiteratureTextTooltip text={attachmentVersion.filename}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Preview {{title}}', {
                title: attachmentVersion.filename
              })}
              disabled={
                trash || attachmentVersion.availability === 'unavailable' || attachmentPending
              }
              onClick={() => actions.current.previewFirstAttachment(entry)}
            >
              <Paperclip className="size-4 text-primary" aria-hidden="true" />
            </Button>
          </LiteratureTextTooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {hasUnavailableAttachment ? (
          <button
            type="button"
            className="block w-full text-xs text-danger-000"
            disabled={trash}
            onClick={(event) => actions.current.openSelectedItemDetail(entry, event.currentTarget)}
          >
            {t('Attachment unavailable')}
          </button>
        ) : null}
      </td>
      <td className="sticky right-0 z-20 w-12 min-w-12 max-w-12 bg-inherit px-2 py-2 align-middle">
        <div className="flex items-center justify-end">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('More actions')}
                disabled={smartTableBlocked}
                className="transition-none"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={trash}
                onSelect={() => actions.current.openSelectedItemDetail(entry)}
              >
                <Pencil className="mr-2 size-4" aria-hidden="true" />
                {t('Edit')}
              </DropdownMenuItem>
              {trash ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isBatching || Boolean(entry.mergedIntoItemId)}
                    onSelect={() => void actions.current.setItemsLifecycle([entry.id], 'active')}
                  >
                    <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                    {t('Restore')}
                  </DropdownMenuItem>
                  {entry.mergedIntoItemId ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        useNavigationStore
                          .getState()
                          .openLiteratureItem(entry.mergedIntoItemId!, 'user')
                      }
                    >
                      <BookOpenText className="mr-2 size-4" aria-hidden="true" />
                      {t('Open retained reference')}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              {!trash ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isBatching}
                    onSelect={() => void actions.current.setItemsLifecycle([entry.id], 'deleted')}
                  >
                    <Trash2 className="mr-2 size-4" aria-hidden="true" />
                    {t('Move to Trash')}
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-danger-000 focus:text-danger-000"
                    disabled={isBatching}
                    onSelect={() => actions.current.requestPermanentDeletion([entry.id])}
                  >
                    <Trash2 className="mr-2 size-4" aria-hidden="true" />
                    {t('Delete permanently')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
})
