import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useEffect, useRef } from 'react'
import { Unplug, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as AlertDialog from '@/components/ui/alert-dialog'
import { ErrorNotice } from '@/components/error-notice'
import {
  useDesktopRuntimeRecoveryStore,
  waitForDesktopSessionRecovery,
  refreshDesktopRecoveryReaders
} from '@/stores/desktop-runtime-recovery-store'
import { useUpdateStore } from '@/stores/update-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { flushComposerDrafts } from '@/pages/workspace/composer-draft-storage'

/** Keeps the application mounted: recovery must never discard editors or composer drafts. */
export function DesktopRuntimeRecovery(): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useDesktopRuntimeRecoveryStore()
  const updating = useUpdateStore((store) => store.status.state === 'applying')
  const contentRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const api = window.api.desktopRuntime
    if (!api) return
    let live = true
    const apply = (next: typeof state): void => {
      if (!live) return
      if (
        next.phase !== 'connected' &&
        useDesktopRuntimeRecoveryStore.getState().phase === 'connected'
      ) {
        // Recovery subscribers can disable the composer and blur it before the dialog mounts.
        previousFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
      if (next.phase !== 'connected') flushComposerDrafts()
      useDesktopRuntimeRecoveryStore.setState(next)
    }
    let receivedEvent = false
    const remove = api.onStateChanged((next) => {
      receivedEvent = true
      apply(next)
    })
    void api
      .getState()
      .then((next) => {
        if (!receivedEvent) apply(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      remove()
    }
  }, [])
  useEffect(() => {
    if (state.phase !== 'reconciling') return
    let live = true
    void Promise.all([
      waitForDesktopSessionRecovery(state.epoch),
      refreshDesktopRecoveryReaders(),
      useProjectStore
        .getState()
        .loadProjects()
        .then(() => {
          if (useProjectStore.getState().loadError) throw new Error('Project refresh failed.')
        }),
      useSettingsStore
        .getState()
        .load({ force: true })
        .then((loaded) => {
          if (!loaded) throw new Error('Settings refresh failed.')
        }),
      useSessionJobStore.getState().hydrateForRecovery()
    ]).then(
      () => {
        if (live) void window.api.desktopRuntime?.reconciled(state.epoch, true)
      },
      () => {
        if (live) void window.api.desktopRuntime?.reconciled(state.epoch, false)
      }
    )
    return () => {
      live = false
    }
  }, [state.epoch, state.phase])
  // The update dialog owns planned shutdown; an aborted/failed update restores recovery here.
  if (state.phase === 'connected' || (state.closing && updating)) return null
  const busy = state.phase === 'reconnecting' || state.phase === 'reconciling'
  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          ref={contentRef}
          onOpenAutoFocus={(event) => {
            // This programmatic dialog has no Radix Trigger or Cancel to own focus.
            event.preventDefault()
            previousFocus.current ??=
              document.activeElement instanceof HTMLElement ? document.activeElement : null
            contentRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (previousFocus.current?.isConnected) previousFocus.current.focus()
            previousFocus.current = null
          }}
          className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] p-4')}
        >
          <AlertDialog.Title className="sr-only">{t('Desktop connection lost')}</AlertDialog.Title>
          <AlertDialog.Description className="sr-only">
            {t(
              'Your local drafts remain open. Submitted operations may have completed; they will not be retried.'
            )}
          </AlertDialog.Description>
          <ErrorNotice
            inline
            icon={busy ? LoaderCircle : Unplug}
            iconClassName={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
            tone="amber"
            role="status"
            title={busy ? t('Restoring desktop connection…') : t('Desktop connection lost')}
            description={
              state.phase === 'unavailable'
                ? t(
                    'The connection cannot be restored. Quit and reopen the app, then check your tasks. Submitted operations may have completed and will not be retried automatically.'
                  )
                : t(
                    'Your local drafts remain open. Submitted operations may have completed; they will not be retried.'
                  )
            }
            secondaryButton={
              state.phase !== 'unavailable' && !busy
                ? {
                    label: t('Quit', { context: 'verb', ns: 'common' }),
                    disabled: state.closing,
                    onClick: () => {
                      void window.api.desktopRuntime?.quit()
                    }
                  }
                : undefined
            }
            primaryButton={
              !busy
                ? {
                    label:
                      state.phase === 'unavailable'
                        ? t('Quit', { context: 'verb', ns: 'common' })
                        : t('Reconnect'),
                    variant: 'default',
                    disabled: state.closing,
                    onClick: () => {
                      if (state.phase === 'unavailable') void window.api.desktopRuntime?.quit()
                      else void window.api.desktopRuntime?.reconnect()
                    }
                  }
                : undefined
            }
          />
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
