import { Ban, Check, ChevronRight, CircleHelp, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsSection } from './SettingsLayout'

// Keep Network and Runtimes on the same live policy summary and management entry.
export const NotebookNetworkAccessSummary = ({
  onOpen,
  testId,
  buttonClassName
}: {
  onOpen: () => void
  testId?: string
  buttonClassName?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const notebookNetwork = useSettingsStore((state) => state.notebookNetwork)
  const strictNetwork = notebookNetwork.mode === 'strict'
  // Global grants also have derived trusted entries. Count the same records as the manager once.
  const savedAddressCount =
    (notebookNetwork.trustedPrivateDestinations ?? []).filter((rule) => !rule.managedGrantId)
      .length +
    (notebookNetwork.destinationGrants ?? []).filter((grant) => grant.revokedAt === undefined)
      .length
  const notebookRows = [
    {
      icon: Check,
      title: strictNetwork
        ? t('Whitelist matches can connect')
        : t('HTTPS domains connect directly'),
      description: strictNetwork
        ? t('Protocol, host and port must all match.')
        : t('Includes localhost and domains that resolve to private networks.')
    },
    {
      icon: strictNetwork ? Ban : CircleHelp,
      title: strictNetwork
        ? t('Unlisted connections are blocked')
        : t('HTTP and direct IP connections require authorization'),
      description: strictNetwork
        ? t('Authorization is unavailable. Add the address manually.')
        : t('Trusted addresses do not need repeated authorization.')
    },
    {
      icon: List,
      title: strictNetwork ? t('Strict whitelist') : t('Trusted unsafe addresses'),
      description: strictNetwork ? (
        <>
          {t('{{count}} rules', {
            count: notebookNetwork.strictWhitelist?.length ?? 0,
            defaultValue_one: '{{count}} rule'
          })}
          {' · '}
          {t('{{count}} groups', {
            count: notebookNetwork.strictWhitelistGroups?.length ?? 0,
            defaultValue_one: '{{count}} group'
          })}
        </>
      ) : (
        t('{{count}} saved addresses', {
          count: savedAddressCount,
          defaultValue_one: '{{count}} saved address'
        })
      ),
      manage: true
    }
  ]
  return (
    <SettingsSection
      title={t('Notebook network access')}
      titleAccessory={
        <span
          className={cn(
            'inline-flex rounded-md border px-2 py-1 text-xs font-medium',
            strictNetwork ? 'notebook-network-strict' : 'notebook-network-relaxed'
          )}
          role="status"
        >
          {strictNetwork ? t('Strict mode') : t('Relaxed mode')}
        </span>
      }
      aria-label={t('Notebook network access')}
      data-settings-anchor="network.domains"
      data-testid={testId}
    >
      <ul className="divide-y divide-border rounded-xl border border-border px-3">
        {notebookRows.map(({ icon: Icon, title, description, manage }, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2.5 py-2.5">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"
              aria-hidden="true"
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-sm font-medium leading-5">{title}</p>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
            </div>
            {manage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn('ml-auto shrink-0', buttonClassName)}
                onClick={onOpen}
              >
                {t('Manage access')}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsSection>
  )
}
