import { ChevronDown, Download, Loader2, RefreshCw, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ClaudeInstallSource, ClaudeInstallSourceInfo } from '../../../../shared/settings'

type AgentInstallSourceMenuProps = {
  name: string
  // Semantic, not display copy: it selects both the icon and the translated label, so neither
  // depends on what locale the button happens to render in.
  intent: 'install' | 'repair' | 'update'
  sources: ClaudeInstallSourceInfo[]
  installing: boolean
  disabled: boolean
  npmAvailable: boolean
  blockedInstallSources: Partial<Record<ClaudeInstallSource, string>>
  buttonSize?: React.ComponentProps<typeof Button>['size']
  onInstall: (source: ClaudeInstallSource) => void
}

// The card action and repair dialog share one source picker so availability rules and installer
// routing cannot drift between the two entry points.
const AgentInstallSourceMenu = ({
  name,
  intent,
  sources,
  installing,
  disabled,
  npmAvailable,
  blockedInstallSources,
  buttonSize = 'sm',
  onInstall
}: AgentInstallSourceMenuProps): React.JSX.Element => {
  const { t } = useTranslation()
  const Icon = intent === 'repair' ? Wrench : intent === 'update' ? RefreshCw : Download
  const label =
    intent === 'repair'
      ? t('Repair')
      : intent === 'update'
        ? t('Update', { context: 'verb' })
        : t('Install')
  const busyLabel = intent === 'update' ? t('Updating…') : t('Installing…')
  const managedSource = sources.find((source) => source.id === 'managed')
  const managedUnavailableReason = managedSource
    ? (blockedInstallSources.managed ??
      (managedSource.requiresNpm && !npmAvailable ? t('npm not found') : undefined))
    : t('App-managed download unavailable')

  const sourceItems = (items: ClaudeInstallSourceInfo[]): React.JSX.Element[] =>
    items.map((item) => {
      // Keep unavailable sources visible with a reason so users can understand what prerequisite
      // is missing without losing the complete set of supported repair paths.
      const npmMissing = item.requiresNpm && !npmAvailable
      const unavailableReason =
        blockedInstallSources[item.id] ?? (npmMissing ? t('npm not found') : undefined)
      return (
        <DropdownMenuItem
          key={item.id}
          disabled={Boolean(unavailableReason)}
          onSelect={() => onInstall(item.id)}
          className="flex flex-col items-start gap-0.5"
        >
          <span>
            {t(item.labelKey)}
            {unavailableReason ? ` (${unavailableReason})` : ''}
          </span>
          {item.descriptionKey ? (
            <span className="text-xs text-muted-foreground">{t(item.descriptionKey)}</span>
          ) : item.displayCommand ? (
            <span className="font-mono text-xs text-muted-foreground">{item.displayCommand}</span>
          ) : null}
        </DropdownMenuItem>
      )
    })

  if (intent === 'update') {
    return (
      <Button
        type="button"
        size={buttonSize}
        disabled={installing || disabled || Boolean(managedUnavailableReason)}
        title={managedUnavailableReason}
        aria-label={t('{{action}} {{name}}', { action: label, name })}
        onClick={() => onInstall('managed')}
      >
        {installing ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
        {installing ? busyLabel : label}
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size={buttonSize}
          disabled={installing || disabled}
          aria-label={t('{{action}} {{name}}', { action: label, name })}
        >
          {installing ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Icon aria-hidden />
          )}
          {installing ? busyLabel : label}
          {!installing ? <ChevronDown aria-hidden="true" /> : null}
        </Button>
      </DropdownMenuTrigger>
      {/* The same menu is portaled from the z-60 repair dialog, so its layer must clear that modal. */}
      <DropdownMenuContent align="end" className="z-[70] w-80">
        <DropdownMenuLabel>{t('Install source')}</DropdownMenuLabel>
        {sourceItems(sources)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { AgentInstallSourceMenu }
export type { AgentInstallSourceMenuProps }
