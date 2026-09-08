import { Check } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import type { AppIconPreview, AppIconVariant } from '../../../../shared/settings'
import { SettingsSection } from './SettingsLayout'

// Lets Windows/Linux users switch the app-window icon between built-in variants. macOS intentionally
// does not render this section: its installed icon comes from Icon Composer and its live Dock icon is
// bound to General > Theme, so exposing an independent picker there would create competing controls.
const AppIconSection = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const appIconVariant = useSettingsStore((state) => state.appIconVariant)
  const setAppIconVariant = useSettingsStore((state) => state.setAppIconVariant)
  const [previews, setPreviews] = useState<AppIconPreview[]>([])

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const listAppIcons = window.api.settings.listAppIcons
  const labels = { light: t('Light'), dark: t('Dark') }
  const descriptions = {
    light: t('The light Open-Science logo.'),
    dark: t('The dark Open-Science logo.')
  }

  useEffect(() => {
    // Guarded: the channel is absent in web mode and on older backends. Reading it optionally (rather
    // than assuming it exists) keeps the effect from throwing during commit, which would otherwise
    // tear down the whole settings surface.
    if (!listAppIcons) return

    let active = true
    void Promise.resolve()
      .then(() => listAppIcons())
      .then((result) => {
        if (active) {
          setPreviews(result)
          setLoadState('ready')
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load app icon previews', error)
        if (active) setLoadState('error')
      })
    return () => {
      active = false
    }
  }, [attempt, listAppIcons])

  if (!listAppIcons) return null

  return (
    <SettingsSection
      title={t('App icon')}
      description={t(
        'Choose the built-in icon shown in app windows. On Windows, the tray follows the same choice.'
      )}
      aria-label={t('App icon')}
    >
      {loadState === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('Loading app icons…')}
        </p>
      ) : null}
      {loadState === 'error' ? (
        <p role="alert" className="flex items-baseline gap-2 text-xs text-danger-000">
          <span>{t('Could not load app icons.')}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 focus-visible:outline-auto"
            onClick={() => {
              setLoadState('loading')
              setAttempt((value) => value + 1)
            }}
          >
            {t('Retry')}
          </button>
        </p>
      ) : null}
      {loadState === 'ready' && previews.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('No app icons are available.')}
        </p>
      ) : null}
      {loadState === 'ready' && previews.length > 0 ? (
        <>
          <RadioGroup.Root
            aria-label={t('App icon')}
            value={appIconVariant}
            onValueChange={(value) => void setAppIconVariant(value as AppIconVariant)}
            orientation="horizontal"
            className="flex flex-wrap gap-3"
          >
            {previews.map((preview) => {
              const selected = preview.id === appIconVariant
              return (
                <RadioGroup.Item
                  key={preview.id}
                  value={preview.id}
                  aria-label={labels[preview.id]}
                  title={descriptions[preview.id]}
                  className={cn(
                    'relative flex w-28 flex-col items-center gap-2 rounded-xl border p-3 text-center transition-colors duration-150 motion-reduce:transition-none',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-card hover:bg-muted hover:text-foreground'
                  )}
                >
                  {selected ? (
                    <span
                      className="absolute right-2 top-2 inline-flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      aria-hidden="true"
                    >
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  ) : null}
                  <img
                    src={preview.previewDataUrl}
                    alt=""
                    aria-hidden="true"
                    className="size-14 rounded-2xl"
                  />
                  <span className="text-xs font-medium text-foreground">{labels[preview.id]}</span>
                </RadioGroup.Item>
              )
            })}
          </RadioGroup.Root>
          {!previews.some((preview) => preview.id === appIconVariant) ? (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              {t('Current icon: {{icon}}. Its preview is unavailable.', {
                icon: labels[appIconVariant]
              })}
            </p>
          ) : null}
        </>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        {t(
          'The new icon appears right away in the app window. The icon in Explorer, the taskbar, the Start menu, or a Linux launcher is part of the installed app and stays the same.'
        )}
      </p>
    </SettingsSection>
  )
}

export { AppIconSection }
