import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'

export const NetworkDestinationGrants = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const settings = useSettingsStore((state) => state.notebookNetwork)
  const setNetwork = useSettingsStore((state) => state.setNotebookNetwork)
  const projects = useProjectStore((state) => state.projects)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState(false)
  const grants = (settings.destinationGrants ?? []).filter((grant) => grant.revokedAt === undefined)
  if (!grants.length) return null
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('Approved network destinations')}</h3>
      {error ? (
        <ErrorNotice description={t('Could not revoke network access. Try again.')} />
      ) : null}
      {grants.map((grant) => (
        <div
          key={grant.id}
          className="flex items-start justify-between gap-3 rounded-md border p-3 text-xs"
        >
          <div className="min-w-0 space-y-1 break-words">
            <p className="font-medium">
              {grant.hostname}:{grant.port}
            </p>
            <p>
              {grant.scope === 'global'
                ? t('All projects')
                : t('Project: {{project}}', {
                    project:
                      projects.find((project) => project.id === grant.projectId)?.name ??
                      grant.projectId
                  })}
            </p>
            <p>
              {t('Resolved addresses: {{addresses}}', {
                addresses: grant.approvedAddresses.join(', ')
              })}
            </p>
            <p>{t('Source session: {{session}}', { session: grant.sessionId })}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== undefined}
            onClick={async () => {
              setBusy(grant.id)
              setError(false)
              try {
                await setNetwork(settings, settings.allowedDomains, undefined, [grant.id])
              } catch {
                setError(true)
              } finally {
                setBusy(undefined)
              }
            }}
          >
            {t('Revoke')}
          </Button>
        </div>
      ))}
    </section>
  )
}
