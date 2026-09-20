import type {
  ClassificationSnapshot,
  ClassificationMutation
} from '../../../src/shared/classification'
import '@/assets/main.css'
import { useState } from 'react'
import { motion } from 'motion/react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { useTagStore } from '@/stores/tag-store'
import { useMemoryStore } from '@/stores/memory-store'
import { ModelPanel } from '@/pages/settings/ModelPanel'
import { SpecialistCapabilitiesSection } from '@/pages/settings/SpecialistCapabilitiesSection'
import { useSettingsStore } from '@/stores/settings-store'

const params = new URLSearchParams(location.search)
const requestedLocale = params.get('locale')
const locale = requestedLocale === 'de' || requestedLocale === 'zh-Hans' ? requestedLocale : 'en'
document.documentElement.classList.toggle('dark', params.has('dark'))
// Only native loading is stubbed. Tabs, panels, styles, i18n and animation are production code.
let classification: ClassificationSnapshot = params.has('classification-ready')
  ? {
      revision: 1,
      services: [
        {
          id: '32c70578-e555-469b-982f-432a4cdbaf78',
          adapter: 'typesafe',
          name: 'TypeSafe',
          configured: true,
          maskedKey: '••••-key'
        }
      ],
      availableProviders: [],
      capabilitySelection: {
        serviceId: '32c70578-e555-469b-982f-432a4cdbaf78',
        modelId: 'jev-latest'
      }
    }
  : { revision: 0, services: [], availableProviders: [] }
if (params.has('openrouter')) {
  classification.availableProviders = [
    { id: '88888888-8888-4888-8888-888888888888', name: 'OpenRouter', maskedKey: '••••1234' }
  ]
  if (params.has('classification-ready')) {
    classification.services.unshift({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'OpenRouter',
      adapter: 'openrouter',
      providerId: classification.availableProviders[0].id,
      configured: true,
      maskedKey: '••••1234'
    })
    classification.capabilitySelection = {
      serviceId: classification.services[0].id,
      modelId: 'typesafe/jev-1.13'
    }
  }
}
window.api = {
  platform: 'darwin',
  settings: {
    getClassification: async () => structuredClone(classification),
    updateClassification: async (request: ClassificationMutation) => {
      if (request.kind === 'save' && params.has('classification-save-fails'))
        return {
          ...structuredClone(classification),
          validation: { ok: false, category: 'auth' as const, status: 401 }
        }
      classification = { ...classification, revision: classification.revision + 1 }
      if (request.kind === 'save')
        classification.services = [
          ...classification.services.filter((item) => item.id !== request.id),
          {
            id: request.id,
            adapter: request.adapter,
            providerId: request.providerId,
            name: request.name,
            configured: true,
            maskedKey: '••••-key'
          }
        ]
      if (request.kind === 'bind') classification.capabilitySelection = request.binding
      if (request.kind === 'remove')
        classification = {
          ...classification,
          services: classification.services.filter((item) => item.id !== request.id),
          capabilitySelection: undefined
        }
      return structuredClone(classification)
    },
    // Presentation fixtures never call a provider or store a real credential.
    testClassification: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      return { ok: params.has('classification-check-pass') }
    }
  },
  localModels: {
    getSnapshot: async () => ({
      availability: 'notInstalled',
      recommendedRevision: 'v1',
      downloadBytes: 100,
      installedBytes: 0,
      transferredBytes: 0,
      updateAvailable: false,
      hasFiles: false,
      inUse: false
    })
  }
} as unknown as typeof window.api
useSettingsStore.setState({
  isLoaded: true,
  load: async () => true,
  skills: [],
  connectors: [],
  customServers: [],
  loadSkills: async () => undefined,
  loadConnectors: async () => undefined
})

const unsubscribe = (): (() => void) => () => undefined
useTagStore.setState({ load: async () => undefined, listen: unsubscribe })
useMemoryStore.setState({ listen: unsubscribe })
if (params.has('settings')) useSettingsStore.getState().openSettingsToPanel('model')
if (params.has('classification'))
  useSettingsStore.setState({
    isSettingsOpen: true,
    pendingSettingsIntent: {
      requestId: 555,
      route: { panel: 'model', view: { kind: 'classification' } }
    }
  })

export function Models(): React.JSX.Element {
  const [local, setLocal] = useState(false)
  return (
    <ModelPanel local={local} onChange={setLocal}>
      <div className="h-12" />
    </ModelPanel>
  )
}
export function Fixture(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'skills' | 'connectors'>('skills')
  const [mode, setMode] = useState<'full' | 'selected'>('selected')
  const [skills, setSkills] = useState<string[]>([])
  const [connectors, setConnectors] = useState<string[]>([])
  if (params.has('settings')) return <SettingsPage open onClose={() => undefined} />
  return (
    <motion.main
      layoutRoot
      layoutScroll
      className="fixed inset-6 overflow-y-auto rounded-xl border border-border bg-background text-foreground"
      data-scroll-frame
    >
      <div className="mx-auto max-w-2xl py-8">
        <section data-models>
          <Models />
        </section>
        <section className="px-5 py-8" data-capabilities>
          <SpecialistCapabilitiesSection
            capabilityMode={mode}
            onCapabilityModeChange={setMode}
            selectedSkillIds={skills}
            excludedSkillIds={[]}
            selectedConnectorIds={connectors}
            excludedConnectorIds={[]}
            updateSkillIds={setSkills}
            updateConnectorIds={setConnectors}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
          />
        </section>
        {params.has('duplicate') && (
          <section data-second-models>
            <Models />
          </section>
        )}
        <div className="h-[600px]" aria-hidden="true" />
      </div>
    </motion.main>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
