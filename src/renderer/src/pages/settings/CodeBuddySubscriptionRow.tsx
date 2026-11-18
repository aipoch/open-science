import { CircleCheck, Loader2, LogIn, LogOut, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'
import {
  WORKBUDDY_PROFILE_MESSAGE,
  type CodeBuddyAccountRequest,
  type CodeBuddyAuthMode,
  type CodeBuddySite
} from '../../../../shared/codebuddy-subscription'
import type { ProviderView } from '../../../../shared/settings'
import { ProviderKindIcon } from './provider-icons'
import { SettingsIconAction, SettingsListCard } from './SettingsLayout'

type AccountAction = CodeBuddyAccountRequest['action']

function useCodeBuddyAccount(
  site: CodeBuddySite,
  configured: boolean,
  mode: CodeBuddyAuthMode = 'isolated'
): {
  signedIn: boolean | undefined
  pending: AccountAction | undefined
  run: (action: AccountAction) => Promise<boolean>
  error: React.JSX.Element | null
} {
  const { t } = useTranslation()
  const account = useSettingsStore((state) => state.codeBuddyAccount)
  const [signedIn, setSignedIn] = useState<boolean | undefined>(configured ? undefined : false)
  const [pending, setPending] = useState<AccountAction | undefined>(
    configured ? 'status' : undefined
  )
  const [failed, setFailed] = useState<AccountAction | 'no-shared-login' | 'workbuddy-profile'>()
  const current = useRef<{ action: AccountAction } | undefined>(undefined)
  const run = useCallback(
    async (action: AccountAction): Promise<boolean> => {
      const operation = { action }
      current.current = operation
      setPending(action)
      setFailed(undefined)
      try {
        const result = await account({ site, action, ...(action === 'login' && { mode }) })
        if (current.current !== operation) return false
        if (!result.ok && (result.category !== 'auth' || action === 'login')) {
          setFailed(
            action === 'login' && mode === 'shared' && result.category === 'auth'
              ? result.message === WORKBUDDY_PROFILE_MESSAGE
                ? 'workbuddy-profile'
                : 'no-shared-login'
              : action
          )
        } else if (action !== 'cancel') {
          setSignedIn(result.ok && action !== 'logout')
        }
        return result.ok
      } catch {
        if (current.current === operation) {
          setFailed(action)
          if (configured && action !== 'refresh') setSignedIn(undefined)
        }
        return false
      } finally {
        if (current.current === operation) {
          current.current = undefined
          setPending(undefined)
        }
      }
    },
    [account, configured, mode, site]
  )
  useEffect(() => {
    let mounted = true
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
  const error = failed ? (
    <ErrorNotice
      inline
      role="alert"
      level="error"
      title={
        failed === 'workbuddy-profile'
          ? t('WorkBuddy profile found. Sign in to the selected site in CodeBuddy CLI.')
          : failed === 'no-shared-login'
            ? t('Sign in to the selected site in CodeBuddy CLI.')
            : failed === 'refresh'
              ? t('Could not refresh models from the vendor.')
              : failed === 'status'
                ? t('Could not check CodeBuddy sign-in status.')
                : t('CodeBuddy account request failed.')
      }
    />
  ) : null
  return { pending, signedIn, run, error }
}

export function CodeBuddySignIn({
  site,
  mode,
  onCancel,
  onAdded
}: {
  site: CodeBuddySite
  mode: CodeBuddyAuthMode
  onCancel: () => void
  onAdded: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { pending, run, error } = useCodeBuddyAccount(site, false, mode)
  return (
    <>
      {error}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          disabled={!!pending}
          onClick={async () => {
            if (await run('login')) onAdded()
          }}
        >
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {mode === 'shared' ? t('Connect') : t('Sign in with browser')}
        </Button>
      </div>
    </>
  )
}

export function CodeBuddySubscriptionRow({
  site,
  provider,
  onDelete
}: {
  site: CodeBuddySite
  provider: ProviderView
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { pending, signedIn, run, error } = useCodeBuddyAccount(
    site,
    true,
    provider.codeBuddyAuthMode
  )
  const shared = provider.codeBuddyAuthMode === 'shared'
  const action =
    pending === 'login'
      ? 'cancel'
      : signedIn === undefined
        ? 'status'
        : signedIn
          ? 'logout'
          : 'login'
  const authActions = {
    login: { label: shared ? t('Connect') : t('Sign in'), icon: LogIn },
    logout: { label: shared ? t('Disconnect from Open-Science') : t('Sign out'), icon: LogOut },
    cancel: { label: t('Cancel sign-in'), icon: X },
    status: { label: pending === 'status' ? t('Checking…') : t('Retry'), icon: RefreshCw }
  }
  return (
    <SettingsListCard
      name={site === 'internal' ? t('CodeBuddy (China)') : t('CodeBuddy (International)')}
      badge={
        <>
          <ProviderKindIcon kindKey={provider.type} className="size-3" />
          {t('Subscription')}
        </>
      }
      indicators={
        signedIn && (
          <CircleCheck
            className="size-3.5 shrink-0 text-emerald-500"
            role="img"
            aria-label={t('Connection verified')}
          />
        )
      }
      detail={
        <>
          {signedIn
            ? t('{{count}} models', {
                defaultValue_one: '{{count}} model',
                count: provider.models.length
              })
            : signedIn === false
              ? t('Not signed in')
              : pending === 'status'
                ? t('Checking…')
                : null}
          {error}
        </>
      }
      actions={
        <>
          {signedIn && (
            <SettingsIconAction
              label={pending === 'refresh' ? t('Refreshing…') : t('Refresh from vendor')}
              icon={RefreshCw}
              disabled={!!pending}
              onClick={() => void run('refresh')}
              className="border border-border text-foreground"
            />
          )}
          <SettingsIconAction
            {...authActions[action]}
            disabled={!!pending && pending !== 'login'}
            onClick={() => void run(action)}
            className="border border-border text-foreground"
          />
          <SettingsIconAction
            label={t('Delete')}
            icon={Trash2}
            onClick={onDelete}
            disabled={!!pending}
            danger
            className="border border-border"
          />
        </>
      }
    />
  )
}
