import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useSettingsStore } from '@/stores/settings-store'
import type { CodeBuddySite } from '../../../../shared/codebuddy-subscription'
import { AgentFrameworkIcon } from './provider-icons'

export function CodeBuddySubscriptionRow({
  site,
  configured
}: {
  site: CodeBuddySite
  configured: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const account = useSettingsStore((state) => state.codeBuddyAccount)
  const [signedIn, setSignedIn] = useState(false)
  const [pending, setPending] = useState<'login' | 'logout' | 'status' | undefined>(
    configured ? 'status' : undefined
  )
  const [failed, setFailed] = useState(false)
  const generation = useRef<symbol | null>(null)
  const login = useRef(false)
  useEffect(() => {
    const current = Symbol()
    generation.current = current
    if (configured) {
      void account({ site, action: 'status' })
        .then((result) => {
          if (current === generation.current) setSignedIn(result.ok)
        })
        .catch(() => {
          if (current === generation.current) setFailed(true)
        })
        .finally(() => {
          if (current === generation.current) setPending(undefined)
        })
    }
    return () => {
      generation.current = null
      if (login.current) {
        login.current = false
        void account({ site, action: 'cancel' }).catch(() => undefined)
      }
    }
  }, [account, site, configured])
  const act = async (): Promise<void> => {
    const current = Symbol()
    generation.current = current
    const action = signedIn ? 'logout' : 'login'
    login.current = action === 'login'
    setPending(action)
    setFailed(false)
    try {
      const result = await account({ site, action })
      if (current !== generation.current) return
      if (result.ok) setSignedIn(action === 'login')
      setFailed(!result.ok)
    } catch {
      if (current === generation.current) setFailed(true)
    } finally {
      if (current === generation.current) {
        login.current = false
        setPending(undefined)
      }
    }
  }
  const cancel = async (): Promise<void> => {
    generation.current = null
    login.current = false
    try {
      await account({ site, action: 'cancel' })
    } catch {
      setFailed(true)
    } finally {
      setPending(undefined)
    }
  }
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <AgentFrameworkIcon frameworkId="codebuddy" className="size-5" />
        <span className="flex-1 text-sm font-medium">
          {site === 'internal' ? t('CodeBuddy (China)') : t('CodeBuddy (International)')}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending === 'logout' || pending === 'status'}
          onClick={() => void (pending === 'login' ? cancel() : act())}
        >
          {pending === 'login' ? t('Cancel') : signedIn ? t('Sign out') : t('Sign in')}
        </Button>
      </div>
      {failed && (
        <ErrorNotice inline level="error" title={t('CodeBuddy account request failed.')} />
      )}
    </div>
  )
}
