import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { validateLocalPath } from '../../../../shared/local-fs'
import { createPreviewFileItemFromLocal } from './preview-file-item'

export const SessionDataFileLink = ({
  path,
  notebookSessionId,
  className,
  children
}: {
  path: string
  notebookSessionId?: string
  className?: string
  children?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [failure, setFailure] = useState<'open' | 'reveal'>()
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      attempt.current++
      clearTimeout(timer.current)
    },
    []
  )
  const name = path.split(/[\\/]/u).at(-1) ?? path
  if (validateLocalPath(path, window.api.platform))
    return (
      <span>
        {children} (<code>{path}</code>)
      </span>
    )
  const run = async (reveal: boolean): Promise<void> => {
    const current = ++attempt.current
    clearTimeout(timer.current)
    setFailure(undefined)
    try {
      if (reveal) await window.api.localFs.reveal(path)
      else if (notebookSessionId) {
        const item = createPreviewFileItemFromLocal({
          path,
          sessionId: notebookSessionId,
          name
        })
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem({ ...item, fromNotebookDataLink: true })
      } else {
        const error = await window.api.localFs.openPath(path)
        if (error) throw new Error(error)
      }
    } catch {
      if (attempt.current !== current) return
      setFailure(reveal ? 'reveal' : 'open')
      timer.current = setTimeout(() => setFailure(undefined), 5000)
    }
  }
  return (
    <>
      <button
        type="button"
        className={className}
        title={path}
        data-session-message-link=""
        data-session-data-file-link=""
        data-streamdown="link"
        onClick={() => void run(false)}
      >
        {children}
      </button>
      <button
        type="button"
        className="ml-1 inline-flex align-middle text-text-300 hover:text-text-100"
        title={t('Show in folder')}
        aria-label={t('Show in folder')}
        onClick={() => void run(true)}
      >
        <FolderOpen className="size-3.5" aria-hidden="true" />
      </button>
      <span
        role="status"
        aria-atomic="true"
        className="text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground"
      >
        {failure && (
          <span className="ml-1">
            {failure === 'open' ? t('Could not open this file.') : t('Could not open that folder.')}
          </span>
        )}
      </span>
    </>
  )
}
