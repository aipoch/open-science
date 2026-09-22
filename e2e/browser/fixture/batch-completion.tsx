import '@/assets/main.css'
import '@/pages/settings/skill-marketplace.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { SkillMarketplaceBatchControls } from '@/pages/settings/SkillMarketplaceBatch'
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

export function Fixture(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-4xl space-y-5 p-5 text-foreground">
      <h1 className="text-lg font-semibold">
        Batch completion · production components, fixture data
      </h1>
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
