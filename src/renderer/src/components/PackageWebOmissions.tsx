import { useTranslation } from 'react-i18next'
import {
  packageWebOmissionSchema,
  type PackageWebOmission
} from '../../../shared/session-package-web'

export const PackageWebOmissions = ({
  omissions
}: {
  omissions?: readonly PackageWebOmission[]
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const valid = (omissions ?? []).flatMap((value) => {
    const result = packageWebOmissionSchema.safeParse(value)
    return result.success ? [result.data] : []
  })
  if (!valid.length) return null
  const component = {
    query_history: t('Web query history'),
    source_manifest: t('Web source metadata'),
    provider_excerpt: t('Search service excerpts'),
    model_synthesis: t('Model-generated response'),
    fetch_body: t('Fetched page text')
  }
  const reason = {
    'policy-denied': t('Sharing is not permitted by the data policy'),
    'policy-unknown': t('Sharing permission has not been confirmed'),
    missing: t('Recorded evidence is missing'),
    invalid: t('Recorded evidence failed validation'),
    redacted: t('Sensitive content was removed'),
    'size-limit': t('Content exceeded the package size limit')
  }
  return (
    <section
      data-testid="package-web-omissions"
      className="space-y-2 rounded-lg border border-border p-3 text-xs leading-5"
    >
      <h3 className="font-medium">{t('Web evidence not included')}</h3>
      <ul className="list-disc space-y-1 pl-4">
        {valid.map((item, index) => {
          const total = item.count
          return (
            <li key={index}>
              {t('{{component}}: {{total}} · {{reason}}', {
                component: component[item.component],
                total,
                reason: reason[item.reason]
              })}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
