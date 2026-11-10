import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { errorDetail } from '@/lib/error-detail'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { validateLocalPath } from '../../../../shared/local-fs'
import type { NotebookSessionReference } from '../../../../shared/notebook'

import { createPreviewFileItemFromUpload } from './preview-file-item'

export const SessionDataFileLink = ({
  path,
  notebook,
  className,
  children
}: {
  path: string
  notebook: NotebookSessionReference
  className?: string
  children?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState<'import' | 'reveal'>()
  const stage = window.api.uploads?.stageLocalPath
  const [failure, setFailure] = useState<string>()
  const name = path.split(/[\\/]/u).at(-1)!
  const canReveal =
    typeof window.api.localFs?.reveal === 'function' &&
    validateLocalPath(path, window.api.platform) === undefined
  const busyRef = useRef(false)
  const importedRef = useRef<PreviewFileItem>(undefined)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const open = async (): Promise<void> => {
    if (busyRef.current || !stage) return
    busyRef.current = true
    setBusy('import')
    setFailure(undefined)
    try {
      const attachment = await stage({
        transferId: crypto.randomUUID(),
        projectId: notebook.projectId,
        notebookSessionId: notebook.sessionId,
        sourcePath: path,
        name
      })
      if (!mountedRef.current) return
      const item = createPreviewFileItemFromUpload(
        attachment,
        attachment.sessionId,
        notebook.projectId
      )
      importedRef.current = item
      setDialogOpen(false)
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
    } catch (error) {
      if (mountedRef.current) setFailure(errorDetail(error) ?? t('Preview unavailable'))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(undefined)
    }
  }

  const reveal = async (): Promise<void> => {
    if (!canReveal || busyRef.current) return
    busyRef.current = true
    setBusy('reveal')
    setFailure(undefined)
    try {
      await window.api.localFs.reveal(path)
      if (mountedRef.current) setDialogOpen(false)
    } catch (error) {
      if (mountedRef.current) setFailure(errorDetail(error) ?? t('Preview unavailable'))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(undefined)
    }
  }

  return (
    <Dialog.Root
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!busyRef.current) setDialogOpen(open)
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={className}
          title={t('Preview {{name}}', { name })}
          data-session-message-link=""
          data-session-data-file-link=""
          data-streamdown="link"
          onClick={(event) => {
            if (importedRef.current) {
              event.preventDefault()
              usePreviewWorkbenchStore.getState().upsertAndActivateItem(importedRef.current)
            } else {
              setFailure(undefined)
            }
          }}
        >
          {children}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          data-session-data-file-dialog=""
          className={dialogPanelClassName('w-[min(480px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {t('Import file for preview')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label={t('Close')}
                disabled={Boolean(busy)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className={`${dialogBodyClassName} space-y-3`}>
            <p className="text-sm font-medium text-text-000">{name}</p>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'This link points to a file in this conversation. Importing saves a copy in the project.'
              )}
            </Dialog.Description>
            {!stage ? (
              <ErrorNotice inline level="info" role="status" title={t('Preview unavailable')} />
            ) : null}
            {failure ? (
              <ErrorNotice
                inline
                role="alert"
                title={t('Could not open this file.')}
                description={failure}
              />
            ) : null}
          </div>
          <div className={dialogFooterClassName}>
            {canReveal ? (
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => void reveal()}
              >
                {t('Show in folder')}
              </Button>
            ) : null}
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                disabled={Boolean(busy)}
              >
                {t('Cancel')}
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              disabled={Boolean(busy) || !stage}
              aria-busy={busy === 'import' || undefined}
              onClick={() => void open()}
            >
              {t('Import and preview')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
