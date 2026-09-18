import '@/assets/main.css'
import '@/pages/settings/skill-marketplace.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { BatchManageLayout } from '@/pages/settings/BatchManageLayout'
import { SkillMarketplaceBatchControls } from '@/pages/settings/SkillMarketplaceBatch'
import { ErrorNotice } from '@/components/error-notice'
import type { SkillMarketplaceBatch } from '../../../src/shared/skill-marketplace'

const params = new URLSearchParams(location.search)
const failed = params.has('failed')
const batch: SkillMarketplaceBatch = {
  id: 'fixture-batch',
  snapshotId: 'a'.repeat(64),
  status: 'completed',
  items: ['literature-review', 'data-analysis'].map((id, index) => ({
    id,
    version: '1.0.0',
    expectedVersion: null,
    status: failed && index === 0 ? 'failed' : 'succeeded'
  }))
}
// The actual renderer components and CSS run against deterministic boundary data.
window.api = {
  platform: 'darwin',
  settings: { getSkillMarketplaceBatch: async () => batch }
} as typeof window.api
const locale = params.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
document.documentElement.classList.toggle('dark', params.has('dark'))
const noop = (): void => {}

export function Management({ name }: { name: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  return (
    <section
      aria-label={name}
      className={`flex ${failed ? 'h-[28rem]' : 'h-56'} flex-col rounded-lg border border-border`}
    >
      <h2 className="px-5 pt-4 text-sm font-semibold">{name}</h2>
      <div className="min-h-0 flex-1">
        <BatchManageLayout
          description={t('Select all results')}
          filters={
            <input aria-label="Search resources" placeholder="Search…" className="text-sm" />
          }
          controlsLabel={`${name} batch controls`}
          visibleCount={2}
          visibleSelectedCount={0}
          selectedCount={0}
          selectedOnly={false}
          busy={false}
          onToggleAll={noop}
          onToggleSelectedOnly={noop}
          onClear={noop}
          actions={null}
          feedback={
            done ? undefined : failed ? (
              <ErrorNotice
                tone="amber"
                description="One item could not be updated. Please retry the failed item."
              />
            ) : (
              <p role="status" className="text-sm font-medium">
                Disabled 2 {name}.
              </p>
            )
          }
          onDone={done ? undefined : () => setDone(true)}
        >
          <p className="text-sm text-muted-foreground">literature-review · data-analysis</p>
        </BatchManageLayout>
      </div>
    </section>
  )
}

export function Fixture(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-4xl space-y-5 p-5 text-foreground">
      <h1 className="text-lg font-semibold">
        Batch completion · production components, fixture data
      </h1>
      <Management name="Skills" />
      <Management name="Connectors" />
      <section
        aria-label="Skill Marketplace"
        className={`flex ${failed ? 'h-[28rem]' : 'h-80'} flex-col rounded-lg border border-border`}
      >
        <SkillMarketplaceBatchControls
          expanded
          heading={<h2 className="text-sm font-semibold">Skill Marketplace</h2>}
          onOpen={noop}
          onExit={noop}
          mode={undefined}
          filteredCount={2}
          showSelection
          onModeChange={noop}
          onSelectFiltered={noop}
          onClearSelection={noop}
          onBusyChange={noop}
          onChanged={noop}
        >
          {() => (
            <p className="p-5 text-sm text-muted-foreground">literature-review · data-analysis</p>
          )}
        </SkillMarketplaceBatchControls>
      </section>
    </main>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
