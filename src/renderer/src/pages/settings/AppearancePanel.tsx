import { useTranslation } from 'react-i18next'

import { LanguageSelect } from '@/components/LanguageControls'
import { ThemeSegmentedControl } from '@/components/ThemeControls'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  INTERFACE_SCALE_OPTIONS,
  isDesktopRenderer,
  type InterfaceScale
} from '@/lib/interface-scale'
import { useInterfaceScaleStore } from '@/stores/interface-scale-store'
import { AppIconSection } from './AppIconSection'
import { SettingsRow, SettingsSection } from './SettingsLayout'

// Appearance owns visual preferences so the General panel can stay focused on app maintenance.
const AppearancePanel = (): React.JSX.Element => {
  const { t } = useTranslation()
  const isMac = window.api.platform === 'darwin'
  const interfaceScale = useInterfaceScaleStore((state) => state.scale)
  const setInterfaceScale = useInterfaceScaleStore((state) => state.setScale)
  const showInterfaceScale = isDesktopRenderer()

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        data-settings-anchor="appearance.preferences"
        title={t('Appearance')}
        aria-label={t('Appearance')}
      >
        <SettingsRow
          label={t('Theme')}
          description={
            isMac
              ? t(
                  'Follow the system setting, or force light or dark. The Dock icon follows the resolved theme.'
                )
              : t('Follow the system setting, or force light or dark.')
          }
          className="pt-0"
        >
          <ThemeSegmentedControl />
        </SettingsRow>

        {showInterfaceScale ? (
          <SettingsRow
            label={t('Interface scale')}
            description={t(
              'Adjust the size of text and controls across the app. Changes apply immediately.'
            )}
          >
            <Select
              value={String(interfaceScale)}
              onValueChange={(value) => {
                const nextScale = Number(value)
                if (INTERFACE_SCALE_OPTIONS.includes(nextScale as InterfaceScale)) {
                  setInterfaceScale(nextScale as InterfaceScale)
                }
              }}
            >
              <SelectTrigger className="w-28" aria-label={t('Interface scale')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERFACE_SCALE_OPTIONS.map((scale) => (
                  <SelectItem key={scale} value={String(scale)}>
                    {Math.round(scale * 100)}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ) : null}

        <SettingsRow
          data-settings-anchor="appearance.language"
          label={t('Language')}
          description={t(
            'Follow the system setting, or pick a language. System is detected once at startup, so a change to your device language takes effect the next time the app opens.'
          )}
        >
          <LanguageSelect />
        </SettingsRow>
      </SettingsSection>

      {!isMac ? <AppIconSection /> : null}
    </div>
  )
}

export { AppearancePanel }
