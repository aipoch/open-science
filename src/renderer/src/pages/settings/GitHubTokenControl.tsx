/* Hallmark · component: credential disclosure · genre: modern-minimal · theme: existing Settings system */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react'

import type { GitHubTokenStatus } from '../../../../shared/settings'
import { DiagnosticDetails } from '@/components/diagnostic-details'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { errorDetail } from '@/lib/error-detail'
import { MaskedPasswordField } from './MaskedPasswordField'

type Feedback =
  | { kind: 'success'; action: 'saved' | 'removed' }
  | { kind: 'error'; action: 'status' | 'verify' | 'remove'; detail?: string }
type Availability = 'checking' | 'available' | 'unavailable'

const feedbackCopy = (feedback: Feedback, t: TFunction): string => {
  switch (feedback.action) {
    case 'saved':
      return t('Token verified and saved.')
    case 'removed':
      return t('Saved token removed.')
    case 'status':
      return t('Could not read GitHub token status.')
    case 'verify':
      return `${t('Token verification failed.')} ${t('Your saved token was not changed.')}`
    case 'remove':
      return t('Could not remove the saved token.')
  }
}

const isLocalOnlyActionError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('only available in the local desktop app')

const GitHubTokenControl = ({ onCancel }: { onCancel?(): void } = {}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<GitHubTokenStatus | null>(null)
  const [availability, setAvailability] = useState<Availability>('checking')
  const [busy, setBusy] = useState<'loading' | 'saving' | 'removing' | null>('loading')
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    let active = true
    void window.api.settings
      .getGitHubTokenStatus()
      .then((next) => {
        if (active) {
          setStatus(next)
          setAvailability('available')
        }
      })
      .catch((error: unknown) => {
        if (!active) return
        if (isLocalOnlyActionError(error)) {
          setAvailability('unavailable')
          return
        }
        setAvailability('available')
        setFeedback({
          kind: 'error',
          action: 'status',
          detail: errorDetail(error)
        })
      })
      .finally(() => {
        if (active) setBusy(null)
      })
    return () => {
      active = false
    }
  }, [])

  const save = async (): Promise<void> => {
    const candidate = token.trim()
    if (!candidate || busy) return
    setBusy('saving')
    setFeedback(null)
    try {
      const next = await window.api.settings.saveGitHubToken({ token: candidate })
      setStatus(next)
      setToken('')
      setFeedback({ kind: 'success', action: 'saved' })
    } catch (error) {
      setFeedback({
        kind: 'error',
        action: 'verify',
        detail: errorDetail(error)
      })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy('removing')
    setFeedback(null)
    try {
      setStatus(await window.api.settings.removeGitHubToken())
      setToken('')
      setFeedback({ kind: 'success', action: 'removed' })
    } catch (error) {
      setFeedback({
        kind: 'error',
        action: 'remove',
        detail: errorDetail(error)
      })
    } finally {
      setBusy(null)
    }
  }

  if (availability !== 'available') return null

  return (
    <section
      id="github-token-settings"
      aria-label={t('GitHub token settings')}
      aria-busy={busy === 'saving' || busy === 'removing'}
      className="space-y-5"
    >
      <div>
        <h2 className="text-base font-semibold">{t('GitHub')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'Used for GitHub Skill discovery and imports. The credential is verified before saving.'
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="github-token" className="text-sm font-medium">
          {t('Personal access token')}
        </label>
        <MaskedPasswordField
          id="github-token"
          placeholder={
            status?.configured ? t('Paste a replacement token') : t('Paste a GitHub token')
          }
          value={token}
          disabled={busy !== null}
          aria-invalid={feedback?.kind === 'error' || undefined}
          aria-describedby="github-token-feedback"
          onChange={(value) => {
            setToken(value)
            setFeedback(null)
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t('Used only for GitHub Skill requests and encrypted with system credential storage.')}{' '}
          <ExternalTextLink href="https://github.com/settings/tokens">
            {t('Manage tokens on GitHub')}
          </ExternalTextLink>
        </p>
      </div>

      <div className="min-h-5 space-y-2">
        {status?.configured ? (
          <p id="github-token-feedback" className="text-xs text-muted-foreground">
            {t('Saved token:')} {status.mask}
          </p>
        ) : null}
        {feedback ? (
          <>
            <div
              id="github-token-feedback"
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              className={`flex items-start gap-2 text-xs ${
                feedback.kind === 'error' ? 'text-danger-000' : 'text-primary'
              }`}
            >
              {feedback.kind === 'error' ? (
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              )}
              <p>{feedbackCopy(feedback, t)}</p>
            </div>
            {feedback.kind === 'error' ? <DiagnosticDetails detail={feedback.detail} /> : null}
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
        ) : null}
        {status?.configured ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            {busy === 'removing' ? t('Removing…') : t('Remove token')}
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={busy !== null || token.trim().length === 0}
          onClick={() => void save()}
        >
          {busy === 'saving' ? (
            <>
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t('Verifying…')}
            </>
          ) : (
            t('Verify and save')
          )}
        </Button>
      </div>
    </section>
  )
}

export { GitHubTokenControl }
