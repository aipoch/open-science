import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import type { AppIconPreview, AppIconVariant } from '../../../../shared/settings'
import { SettingsSection } from './SettingsLayout'

// Lets the user switch the app icon between the built-in variants. Previews are rendered in the main
// process from the bundled assets, so the tile shows exactly what will be applied. The chosen variant
// is applied live to the app window icon (all platforms) and the macOS Dock; the static installed
// icon (Finder .app, Windows .exe in Explorer/Start menu/taskbar, Linux launcher) is baked into the
// build and is never rewritten at runtime — the note below says so, so users don't expect it to follow.
const AppIconSection = (): React.JSX.Element => {
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
      title="App icon"
      description="Choose the built-in icon shown in the app window, and in the Dock on macOS."
      aria-label="App icon"
      separated
    >
      <div role="radiogroup" aria-label="App icon" className="flex flex-wrap gap-3">
        {previews.map((preview) => {
          const selected = preview.id === appIconVariant
          return (
            <button
              key={preview.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preview.label}
              title={preview.description}
              onClick={() => void setAppIconVariant(preview.id as AppIconVariant)}
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
            </button>
          )
        })}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        The new icon appears right away in the app window, and in the Dock on macOS. The icon in
        Finder, Explorer, the taskbar, or the Start menu is part of the installed app and stays the
        same.
      </p>
    </SettingsSection>
  )
}

export { AppIconSection }
