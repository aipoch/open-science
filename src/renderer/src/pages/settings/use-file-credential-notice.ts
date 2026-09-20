import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settings-store'

export const useFileCredentialNotice = (): string | undefined => {
  const { t } = useTranslation()
  const fileStorage = useSettingsStore((state) => state.credentialStore === 'file')
  return fileStorage
    ? t(
        'File credential storage is enabled. New and updated credentials are stored unencrypted in local application files. Existing encrypted credentials are not migrated.'
      )
    : undefined
}
