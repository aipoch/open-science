import { downloadLiteratureRecord } from './literature-read-pages'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'

export function LiteratureOversizedNotice({ itemId }: { itemId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <LiteratureErrorNotice
      title={t('This reference is too large to display. Download the complete record as JSON.')}
      description={failed ? t('References could not be exported.') : undefined}
      primaryButton={{
        label: t('Download JSON'),
        loading,
        onClick: () => {
          if (loading) return
          setLoading(true)
          setFailed(false)
          void downloadLiteratureRecord(itemId)
            .catch(() => setFailed(true))
            .finally(() => setLoading(false))
        }
      }}
    />
  )
}
