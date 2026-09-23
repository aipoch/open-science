import { useState } from 'react'
import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

// The mutation owns no file data. Main persists visibility and broadcasts catalog invalidation.
export const ArtifactHideButton = ({
  projectId,
  fileId,
  name,
  hidden = false
}: {
  projectId: string
  fileId: string
  name: string
  hidden?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const change = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      await window.api.projectFiles.setArtifactHidden({ projectId, fileId, hidden: !hidden })
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={busy}
        className="bg-bg-000/95"
        aria-label={hidden ? t('Unhide {{name}}', { name }) : t('Hide {{name}}', { name })}
        onClick={() => void change()}
      >
        {busy ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : hidden ? (
          <Eye aria-hidden="true" />
        ) : (
          <EyeOff aria-hidden="true" />
        )}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-text-200">
          {t('Could not change file visibility.')}
        </span>
      ) : null}
    </>
  )
}
