import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  CodeBuddyAccountRequest,
  CodeBuddySite
} from '../../../../shared/codebuddy-subscription'
import { AgentFrameworkIcon } from './provider-icons'

type AccountAction = CodeBuddyAccountRequest['action']

export function CodeBuddySubscriptionRow({
  site,
  configured
}: {
  site: CodeBuddySite
  configured: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const account = useSettingsStore((state) => state.codeBuddyAccount)
  const [signedIn, setSignedIn] = useState<boolean | undefined>(configured ? undefined : false)
  const [pending, setPending] = useState<AccountAction | undefined>(
    configured ? 'status' : undefined
  )
  const [failed, setFailed] = useState<AccountAction>()
  const current = useRef<{ action: AccountAction } | undefined>(undefined)
  const run = useCallback(
    async (action: AccountAction) => {
      const operation = { action }
      current.current = operation
      try {
        const result = await account({ site, action })
        if (current.current !== operation) return
        if (!result.ok && result.category !== 'auth') {
          setFailed(action)
        } else if (action !== 'cancel') {
          setSignedIn(result.ok && action !== 'logout')
        }
      } catch {
        if (current.current === operation) {
          setFailed(action)
          if (configured && action !== 'refresh') setSignedIn(undefined)
        }
      } finally {
        if (current.current === operation) {
          current.current = undefined
          setPending(undefined)
        }
      }
    },
    [account, configured, site]
  )
  useEffect(() => {
    let mounted = true
    // Skip launching a status process for a mount already discarded by React.
    if (configured)
      queueMicrotask(() => {
        if (mounted) void run('status')
      })
    return () => {
      mounted = false
      const operation = current.current
      current.current = undefined
      if (operation?.action === 'login')
        void account({ site, action: 'cancel' }).catch(() => undefined)
    }
  }, [account, configured, run, site])

  const start = (action: AccountAction): void => {
    setPending(action)
    setFailed(undefined)
    void run(action)
  }
  const primaryAction =
    pending === 'login'
      ? 'cancel'
      : signedIn === undefined
        ? 'status'
        : signedIn
          ? 'logout'
          : 'login'
  const labels = {
    login: t('Sign in'),
    logout: t('Sign out'),
    cancel: t('Cancel'),
    status: pending === 'status' ? t('Checking…') : t('Retry')
  }
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <AgentFrameworkIcon frameworkId="codebuddy" className="size-5" />
        <span className="flex-1 text-sm font-medium">
          {site === 'internal' ? t('CodeBuddy (China)') : t('CodeBuddy (International)')}
        </span>
        {signedIn && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!!pending}
            onClick={() => start('refresh')}
          >
            {pending === 'refresh' ? t('Refreshing…') : t('Refresh from vendor')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!pending && pending !== 'login'}
          onClick={() => start(primaryAction)}
        >
          {labels[primaryAction]}
        </Button>
      </div>
      {failed && (
        <ErrorNotice
          inline
          level="error"
          title={
            failed === 'refresh'
              ? t('Could not refresh models from the vendor.')
              : failed === 'status'
                ? t('Could not check CodeBuddy sign-in status.')
                : t('CodeBuddy account request failed.')
          }
        />
      )}
    </div>
  )
}
