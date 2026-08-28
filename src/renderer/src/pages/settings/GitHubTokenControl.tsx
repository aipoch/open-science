/* Hallmark · component: credential disclosure · genre: modern-minimal · theme: existing Settings system */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, KeyRound, LoaderCircle } from 'lucide-react'

import type { GitHubTokenStatus } from '../../../../shared/settings'
import { DiagnosticDetails } from '@/components/diagnostic-details'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorDetail } from '@/lib/error-detail'

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

const GitHubTokenControl = ({
  defaultExpanded = false
}: {
  defaultExpanded?: boolean
} = {}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
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
    <>
      <Button
        type="button"
        variant="outline"
        aria-expanded={expanded}
        aria-controls="github-token-settings"
        onClick={() => setExpanded((open) => !open)}
        className="col-start-2 row-start-1 shrink-0 [@media(pointer:coarse)]:min-h-11"
      >
        {busy === 'loading' ? (
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <KeyRound className="size-4" aria-hidden="true" />
        )}
        {status?.configured && status.mask
          ? t('GitHub token · {{mask}}', { mask: status.mask })
          : t('GitHub token')}
      </Button>

      {expanded ? (
        <section
          id="github-token-settings"
          aria-label={t('GitHub token settings')}
          aria-busy={busy === 'saving' || busy === 'removing'}
          className="col-span-full mt-1 border-y border-border bg-muted/20 px-1 py-3"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="github-token" className="block text-xs font-medium text-foreground">
                {t('Personal access token')}
              </label>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                {t(
                  'Used only for GitHub Skill requests and encrypted with system credential storage.'
                )}{' '}
                <ExternalTextLink href="https://github.com/settings/tokens">
                  {t('Manage tokens on GitHub')}
                </ExternalTextLink>
              </p>
              <Input
                id="github-token"
                type="password"
                autoComplete="off"
                placeholder={
                  status?.configured ? t('Paste a replacement token') : t('Paste a GitHub token')
                }
                value={token}
                disabled={busy !== null}
                aria-invalid={feedback?.kind === 'error' || undefined}
                aria-describedby="github-token-feedback"
                onChange={(event) => {
                  setToken(event.target.value)
                  setFeedback(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save()
                }}
                className="mt-2 [@media(pointer:coarse)]:min-h-11"
              />
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || token.trim().length === 0}
                onClick={() => void save()}
                className="[@media(pointer:coarse)]:min-h-11"
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
              {status?.configured ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void remove()}
                  className="text-muted-foreground [@media(pointer:coarse)]:min-h-11"
                >
                  {busy === 'removing' ? t('Removing…') : t('Remove token')}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="mt-2 min-h-5">
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
            ) : status?.configured ? (
              <p id="github-token-feedback" className="text-xs text-muted-foreground">
                {t('Saved token:')} {status.mask}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  )
}

export { GitHubTokenControl }
