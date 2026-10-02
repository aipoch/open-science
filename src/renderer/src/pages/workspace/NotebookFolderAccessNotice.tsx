import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { useNotebookNetworkStatus } from '../settings/use-notebook-network-status'
import { GrantFolderAccessDialog } from './GrantFolderAccessDialog'
import { notebookFolderAccessPath } from './notebook-folder-access'

const FolderAccessAction = ({ path }: { path: string }): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [granted, setGranted] = useState(false)
  const status = useNotebookNetworkStatus()
  if (status.kind !== 'ready') return null
  return (
    <div className="mt-2" data-testid="notebook-folder-access-notice">
      <ErrorNotice
        inline
        tone={granted ? 'teal' : 'amber'}
        description={
          granted
            ? t('Folder access was updated. Run the command again when you are ready.')
            : t('File access failed. System permissions or Notebook protection may be responsible.')
        }
        primaryButton={
          granted
            ? undefined
            : {
                label: t('Grant folder access'),
                onClick: () => setOpen(true)
              }
        }
        content={<p className="break-all font-mono text-xs">{path}</p>}
      />
      <GrantFolderAccessDialog
        open={open}
        onOpenChange={setOpen}
        initialPath={path}
        onGranted={() => setGranted(true)}
      />
    </div>
  )
}

// Only live local owners opt in. Replay and imported records retain display-only defaults.
export const NotebookFolderAccessNotice = ({
  run
}: {
  run: NotebookRunRecord
}): React.JSX.Element | null => {
  const path = notebookFolderAccessPath(run, window.api?.platform ?? '')
  if (!path || !window.api?.localFs) return null
  return <FolderAccessAction key={`${run.runId}:${path}`} path={path} />
}
