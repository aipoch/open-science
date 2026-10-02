import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { SessionDiscussionDialog } from './SessionDiscussionDialog'
import { loadSessionDiscussionContext } from './workspace-session-actions'
import type { SessionDiscussionCapture } from './replay/replay-context'

export const SessionDiscussionButton = ({
  projectId,
  sessionId
}: {
  projectId: string
  sessionId: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [context, setContext] = useState<SessionDiscussionCapture>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => request.current?.abort(), [projectId, sessionId])
  const open = async (): Promise<void> => {
    if (request.current && !request.current.signal.aborted) return
    const abort = new AbortController()
    request.current = abort
    setPending(true)
    setError(undefined)
    try {
      const selection = await loadSessionDiscussionContext(projectId, sessionId, abort.signal)
      if (abort.signal.aborted) return
      if (!selection) throw new Error(t('No recorded steps are available.'))
      setContext(selection)
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!abort.signal.aborted) {
        request.current = undefined
        setPending(false)
      }
    }
  }
  return (
    <>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void open()}>
        {pending ? (
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <MessageSquare className="size-4" aria-hidden="true" />
        )}
        {t('Discuss')}
      </Button>
      {context ? (
        <SessionDiscussionDialog context={context} onClose={() => setContext(undefined)} />
      ) : null}
      {error ? (
        <ErrorNotice
          inline
          tone="amber"
          description={error}
          primaryButton={{ label: t('Retry'), onClick: () => void open(), disabled: pending }}
        />
      ) : null}
    </>
  )
}
