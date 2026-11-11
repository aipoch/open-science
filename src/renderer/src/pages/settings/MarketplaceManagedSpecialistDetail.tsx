import { ResourceDetailActions, ResourceDetailHeader } from '../marketplace/ResourceDetailLayout'
import { inlineNoticeClassName } from '@/components/ui/notice-chrome'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · slop: pass */
import { AlertTriangle, ArrowLeft, Copy, Download, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { SettingsToggle } from './SettingsLayout'
import type { MarketplaceSpecialistListing } from '../../../../shared/specialist-marketplace'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { SpecialistAppearancePicker } from './SpecialistAppearancePicker'

type MarketplaceSpecialist = Extract<SpecialistListItem, { kind: 'custom' }> & {
  origin: 'marketplace'
}

type Props = {
  hideBack?: boolean
  specialist: MarketplaceSpecialist
  update?: MarketplaceSpecialistListing
  sourceMissing: boolean
  disabled?: boolean
  onBack: () => void
  onAppearanceChange: (patch: { iconKey?: string; colorKey?: string }) => Promise<void>
  onToggle: () => void
  onDuplicate?: () => void
  onUpdate: () => void
  onManageSources: () => void
  onUninstall?: () => void
}

const MarketplaceManagedSpecialistDetail = ({
  specialist,
  hideBack,
  update,
  sourceMissing,
  disabled,
  onBack,
  onAppearanceChange,
  onToggle,
  onDuplicate,
  onUpdate,
  onManageSources,
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
        {!hideBack && (
          <Button type="button" variant="ghost" size="sm" className="mb-4" onClick={onBack}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            {t('Back')}
          </Button>
        )}

        <ResourceDetailHeader
          identity={
            <SpecialistAppearancePicker
              name={specialist.displayName ?? specialist.name}
              iconKey={specialist.iconKey}
              colorKey={specialist.colorKey}
              disabled={disabled}
              onChange={onAppearanceChange}
            />
          }
          name={specialist.displayName ?? specialist.name}
          description={specialist.description}
        >
          <span>{t('Marketplace')}</span>
          <span>{t('Version {{version}}', { version: specialist.packageVersion ?? '0.1.0' })}</span>
          {specialist.marketplaceProvenance?.publisher ? (
            <span>
              {t('Publisher: {{publisher}}', {
                publisher: specialist.marketplaceProvenance.publisher
              })}
            </span>
          ) : null}
          {update?.updateAvailable ? (
            <span className="text-primary">{t('Update available')}</span>
          ) : null}
        </ResourceDetailHeader>

        {sourceMissing ? (
          <div className={`${inlineNoticeClassName} mt-5 block`}>
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-status-warning-foreground dark:text-status-warning-dark-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('Marketplace source removed')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'This Specialist remains installed, but updates are unavailable until its Marketplace source is added again.'
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={onManageSources}
                >
                  {t('Manage Marketplace sources')}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            {t(
              'This Specialist is managed by Marketplace. Create an editable copy to change its instructions or capabilities.'
            )}
          </div>
        )}

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

        <ResourceDetailActions
          leading={
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              {specialist.enabled ? t('Enabled') : t('Disabled')}
              <SettingsToggle
                enabled={specialist.enabled}
                disabled={disabled}
                aria-label={t('Toggle {{name}}', {
                  name: specialist.displayName ?? specialist.name
                })}
                onToggle={onToggle}
              />
            </label>
          }
        >
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={disabled || !onUninstall}
            onClick={onUninstall}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            {t('Uninstall')}
          </Button>
          <Button
            type="button"
            variant={update?.updateAvailable ? 'outline' : 'default'}
            disabled={disabled || !onDuplicate}
            onClick={onDuplicate}
          >
            <Copy data-icon="inline-start" aria-hidden="true" />
            {t('Create editable copy')}
          </Button>
          {update?.updateAvailable ? (
            <Button type="button" disabled={disabled} onClick={onUpdate}>
              <Download data-icon="inline-start" aria-hidden="true" />
              {t('Update Specialist')}
            </Button>
          ) : null}
        </ResourceDetailActions>
      </div>
    </div>
  )
}

export { MarketplaceManagedSpecialistDetail }
