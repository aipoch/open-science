/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · slop: pass */
import { ArrowLeft, Copy, Download, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsToggle } from './SettingsLayout'
import type { MarketplaceSpecialistListing } from '../../../../shared/specialist-marketplace'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { SpecialistAppearancePicker } from './SpecialistAppearancePicker'

type MarketplaceSpecialist = Extract<SpecialistListItem, { kind: 'custom' }> & {
  origin: 'marketplace'
}

type Props = {
  specialist: MarketplaceSpecialist
  update?: MarketplaceSpecialistListing
  disabled?: boolean
  onBack: () => void
  onAppearanceChange: (patch: { iconKey?: string; colorKey?: string }) => Promise<void>
  onToggle: () => void
  onDuplicate: () => void
  onUpdate: () => void
  onUninstall: () => void
}

const MarketplaceManagedSpecialistDetail = ({
  specialist,
  update,
  disabled,
  onBack,
  onAppearanceChange,
  onToggle,
  onDuplicate,
  onUpdate,
  onUninstall
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const skillIds =
    specialist.capabilityMode === 'selected'
      ? specialist.selectedCapabilities.skillIds
      : specialist.fullAccess.excludedSkillIds
  const connectorIds =
    specialist.capabilityMode === 'selected'
      ? specialist.selectedCapabilities.connectorIds
      : specialist.fullAccess.excludedConnectorIds
  const skillLabel = specialist.capabilityMode === 'full' ? t('Excluded Skills') : t('Skills')
  const connectorLabel =
    specialist.capabilityMode === 'full' ? t('Excluded Connectors') : t('Connectors')

  return (
    <div className="p-5">
      {/*
       * Hallmark · component: managed-package detail · genre: workbench · theme: project tokens
       * states: default · hover · focus · disabled · update-available · destructive handoff
       * hierarchy: identity/status → safe controls → read-only content → package actions
       * motion: existing control transitions only · slop: pass
       */}
      <div className="max-w-3xl">
        <Button type="button" variant="ghost" size="sm" className="mb-4" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          {t('Back')}
        </Button>

        <div className="flex flex-wrap items-start gap-3 border-b border-border pb-5">
          <SpecialistAppearancePicker
            name={specialist.displayName ?? specialist.name}
            iconKey={specialist.iconKey}
            colorKey={specialist.colorKey}
            disabled={disabled}
            onChange={onAppearanceChange}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-foreground">
                {specialist.displayName ?? specialist.name}
              </h2>
              <Badge variant="secondary">{t('Marketplace')}</Badge>
              {update?.updateAvailable ? (
                <Badge className="border-primary/20 bg-primary/10 text-primary">
                  {t('Update available')}
                </Badge>
              ) : null}
            </div>
            {specialist.description ? (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {specialist.description}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Version {{version}}', { version: specialist.packageVersion ?? '0.1.0' })}
              {specialist.marketplaceProvenance?.publisher
                ? ` · ${t('Publisher: {{publisher}}', {
                    publisher: specialist.marketplaceProvenance.publisher
                  })}`
                : ''}
            </p>
          </div>
          <div className="flex min-h-10 items-center gap-2 rounded-lg border border-border px-3">
            <span className="text-sm text-muted-foreground">
              {specialist.enabled ? t('Enabled') : t('Disabled')}
            </span>
            <SettingsToggle
              enabled={specialist.enabled}
              disabled={disabled}
              aria-label={t('Toggle {{name}}', {
                name: specialist.displayName ?? specialist.name
              })}
              onToggle={onToggle}
            />
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          {t(
            'This Specialist is managed by Marketplace. Create an editable copy to change its instructions or capabilities.'
          )}
        </div>

        {update?.updateAvailable ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('Update available')}</p>
              <p className="text-xs text-muted-foreground">
                {t('Update from v{{current}} to v{{incoming}}', {
                  current: specialist.packageVersion ?? '0.1.0',
                  incoming: update.version
                })}
              </p>
            </div>
            <Button type="button" size="sm" onClick={onUpdate}>
              <Download data-icon="inline-start" aria-hidden="true" />
              {t('Update Specialist')}
            </Button>
          </div>
        ) : null}

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-foreground">{t('Instructions')}</h3>
          <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-sm leading-6 text-foreground">
            {specialist.systemPrompt}
          </div>
        </section>

        <section className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t('Capabilities')}</h3>
            <span className="text-xs text-muted-foreground">
              {specialist.capabilityMode === 'full' ? t('Full access') : t('Selected capabilities')}
            </span>
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">{skillLabel}</p>
              <p className="mt-1 break-words text-sm text-foreground">
                {skillIds.length > 0 ? skillIds.join(', ') : t('None')}
              </p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">{connectorLabel}</p>
              <p className="mt-1 break-words text-sm text-foreground">
                {connectorIds.length > 0 ? connectorIds.join(', ') : t('None')}
              </p>
            </div>
          </div>
        </section>

        <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-border pt-5">
          <Button type="button" variant="outline" disabled={disabled} onClick={onDuplicate}>
            <Copy data-icon="inline-start" aria-hidden="true" />
            {t('Create editable copy')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={disabled}
            onClick={onUninstall}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            {t('Uninstall')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export { MarketplaceManagedSpecialistDetail }
