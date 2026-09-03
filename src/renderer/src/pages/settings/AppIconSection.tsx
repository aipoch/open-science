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
const AppIconSection = (): React.JSX.Element => {
  const { t } = useTranslation()
  const appIconVariant = useSettingsStore((state) => state.appIconVariant)
  const setAppIconVariant = useSettingsStore((state) => state.setAppIconVariant)
  const [previews, setPreviews] = useState<AppIconPreview[]>([])

  useEffect(() => {
    // Guarded: the channel is absent in web mode and on older backends. Reading it optionally (rather
    // than assuming it exists) keeps the effect from throwing during commit, which would otherwise
    // tear down the whole settings surface.
    const listAppIcons = window.api.settings.listAppIcons
    if (!listAppIcons) return

    let active = true
    void Promise.resolve(listAppIcons())
      .then((result) => {
        if (active) setPreviews(result)
      })
      .catch((error: unknown) => {
        console.error('Failed to load app icon previews', error)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <SettingsSection
      title={t('App icon')}
      description={t(
        'Choose the built-in icon shown in app windows. On Windows, the tray follows the same choice.'
      )}
      aria-label={t('App icon')}
    >
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
              aria-label={preview.label}
              title={preview.description}
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
              <span className="text-xs font-medium text-foreground">{preview.label}</span>
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>

      <p className="mt-3 text-xs text-muted-foreground">
        {t(
          'The new icon appears right away in the app window. The icon in Explorer, the taskbar, the Start menu, or a Linux launcher is part of the installed app and stays the same.'
        )}
      </p>
    </SettingsSection>
  )
}

export { AppIconSection }
