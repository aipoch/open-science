import { useRef, useState } from 'react'
import { FileText, History, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { LiteratureItemView } from '../../../../shared/literature'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import { formatBytes } from '../../../../shared/update'
import {
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenu,
  type ActionMenuDefinition,
  type ActionMenuRecipeEntry
} from '@/components/action-menu'

type Version = LiteratureItemView['attachments'][number]['versions'][number]
import { useAttachmentOperations, type AttachmentAction } from './literature-attachment-operations'
import { AttachmentOperationStatus } from './LiteratureAttachmentOperations'
type Attachment = LiteratureItemView['attachments'][number]
type AttachmentMenuAction = AttachmentAction | 'history'
const attachmentActionCatalog: Record<AttachmentMenuAction, ActionMenuDefinition> = {
  history: { labelKey: 'Version history', icon: History },
  verify: { labelKey: 'Retry file verification', icon: RotateCcw },
  remove: { labelKey: 'Remove attachment', icon: Trash2, danger: true }
}
const attachmentActionRecipe: readonly ActionMenuRecipeEntry<AttachmentMenuAction>[] = [
  { kind: 'action', action: 'history' },
  { kind: 'action', action: 'verify' },
  { kind: 'separator' },
  { kind: 'action', action: 'remove' }
]

const AttachmentMenuButton = ({
  targetId,
  title,
  ref
}: {
  targetId: string
  title: string
  ref: React.Ref<HTMLButtonElement>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <button
      ref={ref}
      type="button"
      aria-label={t('Attachment actions for {{title}}', { title })}
      className="m-1 rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu({
          targetId,
          pointer: { x: bounds.left, y: bounds.bottom },
          focusTarget: event.currentTarget
        })
      }}
    >
      <MoreHorizontal className="size-4" aria-hidden="true" />
    </button>
  )
}

const AttachmentPreview = ({
  version,
  title,
  pending = false,
  onPreview
}: {
  version?: Version
  pending?: boolean
  title: string
  onPreview: (version: Version) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const failure = version?.verificationFailure
  const health =
    version?.availability === 'unavailable'
      ? failure === 'missing'
        ? t('File missing')
        : [
              'checksum-mismatch',
              'size-mismatch',
              'not-file',
              'changed-during-verification'
            ].includes(failure ?? '')
          ? t('File damaged')
          : t('File unavailable')
      : version?.availability === 'available'
        ? t('File integrity verified')
        : t('File integrity not yet verified')
  return (
    <button
      type="button"
      disabled={pending || !version || version.availability === 'unavailable'}
      aria-label={t('Preview {{title}}', { title })}
      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
      onClick={() => version && onPreview(version)}
    >
      <FileText className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {version ? (
          <span className="block text-xs text-muted-foreground">
            {formatBytes(version.sizeBytes)}
          </span>
        ) : null}
        <span
          className={
            version?.availability === 'unavailable'
              ? 'block text-xs text-danger-000'
              : 'block text-xs text-muted-foreground'
          }
        >
          {pending ? null : health}
        </span>
        {version && !version.pageCount ? (
          <span className="block text-xs text-muted-foreground">
            {version.sizeBytes > 50 * 1024 * 1024
              ? t('PDF not validated: exceeds the 50 MiB automatic processing limit.')
              : t('PDF structure not yet validated.')}
          </span>
        ) : null}
      </span>
    </button>
  )
}

export const LiteratureAttachments = ({
  item,
  onPreview
}: {
  item: LiteratureItemView
  onPreview: (version: Version) => void
}): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const menuButtons = useRef(new Map<string, HTMLButtonElement>())
  const returnFocus = useRef<HTMLButtonElement | undefined>(undefined)
  const restoreFocus = (event: Event): void => {
    if (returnFocus.current?.isConnected) {
      event.preventDefault()
      returnFocus.current.focus()
    }
  }
  const [removal, setRemoval] = useState<{ itemId: string; attachment: Attachment }>()
  const [history, setHistory] = useState<{ itemId: string; attachmentId: string }>()
  const removalAttachment =
    removal?.itemId === item.id
      ? item.attachments.find(
          (entry) =>
            entry.id === removal.attachment.id &&
            entry.versions.length === removal.attachment.versions.length &&
            entry.versions.every(
              (version, index) => version.id === removal.attachment.versions[index].id
            )
        )
      : undefined
  const historyAttachment =
    history?.itemId === item.id
      ? item.attachments.find((entry) => entry.id === history.attachmentId)
      : undefined
  const operations = useAttachmentOperations((state) => state.operations)
  const itemOperations = operations.filter((operation) => operation.itemId === item.id)
  const pending = itemOperations.some((operation) => operation.pending)
  const run = (action: AttachmentAction, attachmentId: string, versionId?: string): Promise<void> =>
    useAttachmentOperations.getState().run(item, attachmentId, action, versionId)
  return (
    <ActionMenuProvider>
      <div className="mt-2 space-y-2">
        {itemOperations
          .filter(
            (operation) =>
              operation.pending ||
              operation.error ||
              operation.receipt?.cleanupPending ||
              operation.refreshFailed
          )
          .map((operation) => (
            <AttachmentOperationStatus key={operation.attachmentId} operation={operation} />
          ))}
        {item.attachments.map((attachment) => {
          const version = attachment.versions[0]
          const title = version?.filename ?? attachment.title
          const targetId = `literature-attachment:${attachment.id}`
          return (
            <ActionMenuTarget
              key={attachment.id}
              asChild
              targetId={targetId}
              identityKey={`${item.id}:${attachment.id}`}
              catalog={attachmentActionCatalog}
              recipe={attachmentActionRecipe}
              invocation={undefined}
              bindings={{
                verify: {
                  execute: () => run('verify', attachment.id, version?.id),
                  disabled: pending || !version
                },
                history: {
                  execute: () => {
                    returnFocus.current = menuButtons.current.get(attachment.id)
                    setHistory({ itemId: item.id, attachmentId: attachment.id })
                  },
                  hidden: attachment.versions.length < 2,
                  disabled: pending
                },
                remove: {
                  execute: () => {
                    returnFocus.current = menuButtons.current.get(attachment.id)
                    setRemoval({ itemId: item.id, attachment })
                  },
                  disabled: pending
                }
              }}
            >
              <div
                aria-busy={pending}
                className="flex items-center rounded-lg border border-border bg-background"
              >
                <AttachmentPreview
                  pending={pending}
                  version={version}
                  title={title}
                  onPreview={onPreview}
                />
                <AttachmentMenuButton
                  targetId={targetId}
                  title={title}
                  ref={(node) => {
                    if (node) menuButtons.current.set(attachment.id, node)
                    else menuButtons.current.delete(attachment.id)
                  }}
                />
              </div>
            </ActionMenuTarget>
          )
        })}
      </div>
      <ConfirmActionDialog
        open={Boolean(removalAttachment)}
        title={t('Permanently delete attachment')}
        description={[
          t('Permanently delete “{{filename}}”?', {
            filename: removalAttachment?.versions[0]?.filename ?? removalAttachment?.title ?? ''
          }),
          removalAttachment && removalAttachment.versions.length > 1
            ? t('All {{count}} versions will be deleted.', {
                count: removalAttachment.versions.length,
                defaultValue_one: 'The only version will be deleted.'
              })
            : '',
          t(
            'Files saved by the application will be deleted when no other references use them. This cannot be undone and does not move the attachment to Trash. Original files imported from your computer are not deleted.'
          )
        ]
          .filter(Boolean)
          .join(' ')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Permanently delete attachment')}
        destructive
        loading={pending}
        onCloseAutoFocus={restoreFocus}
        onCancel={() => setRemoval(undefined)}
        onConfirm={() => {
          if (!removalAttachment || pending) return
          void run('remove', removalAttachment.id)
          setRemoval(undefined)
        }}
      />
      <Dialog.Root
        open={Boolean(historyAttachment)}
        onOpenChange={(open) => {
          if (!open) setHistory(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            onCloseAutoFocus={restoreFocus}
            className={dialogPanelClassName(
              'flex max-h-[80vh] w-[min(560px,calc(100vw-2rem))] flex-col p-0'
            )}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <Dialog.Title className={dialogTitleClassName}>{t('Version history')}</Dialog.Title>
                <Dialog.Description className={`${dialogDescriptionClassName} break-words`}>
                  {t('Previewing an older version does not change the latest version.')}
                </Dialog.Description>
              </div>
            </div>
            <div className={`${dialogBodyClassName} space-y-3 overflow-y-auto`}>
              {historyAttachment?.versions.map((version) => (
                <div key={version.id} className="rounded-lg border border-border">
                  <div className="flex flex-wrap justify-between gap-2 px-3 pt-3 text-xs text-muted-foreground">
                    <span>{t('Version {{number}}', { number: version.versionNumber })}</span>
                    <time dateTime={new Date(version.createdAt).toISOString()}>
                      {new Date(version.createdAt).toLocaleString(i18n.language)}
                    </time>
                  </div>
                  <div className="flex">
                    <AttachmentPreview
                      pending={pending}
                      version={version}
                      title={version.filename}
                      onPreview={(selected) => {
                        setHistory(undefined)
                        onPreview(selected)
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className={dialogFooterClassName}>
              <Dialog.Close asChild>
                <Button variant="ghost">{t('Close')}</Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ActionMenuProvider>
  )
}
