import type { TFunction } from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ComputeAccountProvider,
  ComputeAccountStatus
} from '../../../../shared/compute-accounts'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
export function computeAccountActionsAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) !== 'remote' &&
    typeof window.api?.compute?.accountStatus === 'function'
  )
}

type Operation =
  'connectAccount' | 'cancelAccountConnection' | 'useLocalAccount' | 'disconnectAccount'
export type ComputeAccountController = {
  status?: ComputeAccountStatus
  busy: boolean
  error: boolean
  check: (force?: boolean) => Promise<void>
  run: (operation: Operation) => Promise<ComputeAccountStatus | undefined>
}
export function computeAccountStatusLabel(
  { status, error }: Pick<ComputeAccountController, 'status' | 'error'>,
  t: TFunction
): string {
  if (error) return t('Connection unavailable')
  switch (status?.state) {
    case 'connected':
      return t('Connected')
    case 'disconnected':
      return t('Not connected')
    case 'pending':
      return status.source === 'local' ? t('Checking…') : t('Waiting for browser authorization')
    case 'expired':
      return t('Authorization expired')
    case 'unavailable':
      return t('Connection unavailable')
    default:
      return t('Checking…')
  }
}

export function useComputeAccount(provider?: ComputeAccountProvider): ComputeAccountController {
  const [status, setStatus] = useState<ComputeAccountStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const gate = useRef({ sequence: 0, actionPending: false })
  const check = useCallback(
    async (force = false) => {
      if (!provider || gate.current.actionPending || !computeAccountActionsAvailable()) return
      const seq = ++gate.current.sequence
      await window.api.compute.accountStatus(provider, force).then(
        (next) => {
          if (seq === gate.current.sequence) {
            setStatus(next)
            setError(false)
          }
        },
        () => {
          if (seq === gate.current.sequence) setError(true)
        }
      )
    },
    [provider]
  )
  useEffect(() => {
    const owner = gate.current
    owner.actionPending = false
    void check()
    const onFocus = (): void => {
      void check()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      owner.sequence++
      window.removeEventListener('focus', onFocus)
    }
  }, [check])

  const pending = status?.state === 'pending'
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      await check()
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [check, pending])

  const run = useCallback(
    async (operation: Operation): Promise<ComputeAccountStatus | undefined> => {
      if (!provider || !computeAccountActionsAvailable()) return
      // A close can arrive before the outstanding browser-start call returns.
      if (gate.current.actionPending && operation !== 'cancelAccountConnection') return
      const seq = ++gate.current.sequence
      gate.current.actionPending = true
      setBusy(true)
      setError(false)
      try {
        const next = await window.api.compute[operation](provider)
        if (seq === gate.current.sequence) {
          setStatus(next)
          return next
        }
      } catch {
        if (seq === gate.current.sequence) setError(true)
      } finally {
        if (seq === gate.current.sequence) {
          gate.current.actionPending = false
          setBusy(false)
        }
      }
      return undefined
    },
    [provider]
  )
  return { status: status?.provider === provider ? status : undefined, busy, error, check, run }
}
