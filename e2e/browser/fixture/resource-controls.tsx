import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillsPanel, type SkillsView } from '@/pages/settings/SkillsPanel'
import { ConnectorsPanel, type ConnectorsView } from '@/pages/settings/ConnectorsPanel'
import { ConnectorDetailView } from '@/pages/settings/ConnectorDetailView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useThemeStore } from '@/stores/theme-store'
import { CONNECTOR_CATALOG } from '../../../src/main/connectors/catalog'
import manifest from '../../../resources/skills/manifest.json'
import type { SkillView, ConnectorsSnapshot } from '../../../src/shared/settings'
import type { SpecialistView, UpdateSpecialistInput } from '../../../src/shared/specialist'

const query = new URLSearchParams(location.search)
const locale = query.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const connectorPage = query.has('connectors')
useThemeStore.getState().setPreference(query.has('dark') ? 'dark' : 'light')
let skills: SkillView[] = manifest.skills
  .filter((item) => !['self-awareness', 'skill-creator'].includes(item.id))
  .map((item, index) => ({
    id: item.id,
    name: item.name,
    displayName: item.name,
    description: `Research workflow · ${item.name}`,
    source: 'featured',
    updatedAt: item.updatedAt,
    enabled: index === 0 || item.activationPolicy === 'always-on',
    activationPolicy: item.activationPolicy === 'always-on' ? 'always-on' : undefined
  }))
skills.push(
  ...['imported', 'personal'].flatMap((source) =>
    Array.from({ length: 6 }, (_, index) => ({
      id: `${source}-${index}`,
      name: `${source}-${index}`,
      displayName: `${source === 'personal' ? 'Personal' : 'Imported'} workflow ${index + 1}`,
      description: 'Research methods and reproducible analysis',
      source: source as 'personal' | 'imported',
      updatedAt: '2026-09-20T00:00:00Z',
      enabled: index === 0
    }))
  )
)
let connectors: ConnectorsSnapshot = {
  connectors: CONNECTOR_CATALOG.map((item, index) => ({
    ...item,
    name: item.id,
    group: item.group ?? 'featured',
    enabled: index === 0,
    autoAllow: false
  })),
  customServers: [
    {
      id: 'lab',
      name: 'lab-tools',
      displayName: 'Lab tools',
      description: 'Local research tools',
      transport: 'stdio',
      enabled: true,
      command: 'node'
    }
  ],
  ncbi: { hasApiKey: false }
}
let specialists: SpecialistView[] = Array.from(
  { length: Number(query.get('specialists') ?? 18) },
  (_, index) => ({
    id: `research-${index}`,
    name: `RESEARCH_${index}`,
    displayName: index === 0 ? 'Researcher' : `Research team ${index + 1}`,
    description: '',
    systemPrompt: '',
    enabled: true,
    revision: 1,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: {
      skillIds: index === 0 ? ['alphafold2'] : [],
      connectorIds: index === 0 ? [CONNECTOR_CATALOG[0].id] : [],
      connectorTools: []
    }
  })
)
const noop = (): void => {}
window.api = {
  platform: 'darwin',
  settings: {
    listSkills: async () => structuredClone(skills),
    setSkillEnabled: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      skills = skills.map((item) =>
        item.id === id && item.activationPolicy !== 'always-on' ? { ...item, enabled } : item
      )
      return structuredClone(skills)
    },
    deleteSkill: async ({ id }: { id: string }) => {
      skills = skills.filter((item) => item.id !== id)
      return structuredClone(skills)
    },
    getSkillDetail: async (id: string) => ({
      ...skills.find((item) => item.id === id),
      body: '# Research workflow',
      metadata: {},
      references: [],
      packageFiles: []
    }),
    getConnectors: async () => structuredClone(connectors),
    setConnectorEnabled: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      connectors = {
        ...connectors,
        connectors: connectors.connectors.map((item) =>
          item.id === id ? { ...item, enabled } : item
        )
      }
      return structuredClone(connectors)
    },
    setCustomServerEnabled: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      connectors = {
        ...connectors,
        customServers: connectors.customServers.map((item) =>
          item.id === id ? { ...item, enabled } : item
        )
      }
      return structuredClone(connectors)
    },
    removeCustomServer: async ({ id }: { id: string }) => {
      connectors = {
        ...connectors,
        customServers: connectors.customServers.filter((item) => item.id !== id)
      }
      return structuredClone(connectors)
    },
    getConnectorDetail: async (id: string) => ({
      ...connectors.connectors.find((item) => item.id === id),
      tools: []
    }),
    onConnectorRuntimeChanged: () => noop,
    onSkillCatalogChanged: () => noop
  },
  specialist: {
    list: async () => ({
      items: specialists.map((item) => ({ ...structuredClone(item), kind: 'custom' })),
      integrity: { status: 'ok' }
    }),
    update: async (input: UpdateSpecialistInput) => {
      const item = specialists.find((item) => item.id === input.id)!
      if (item.revision !== input.revision) throw new Error('revision conflict')
      const updated = { ...item, ...input, revision: item.revision + 1 }
      specialists = specialists.map((item) => (item.id === updated.id ? updated : item))
      return structuredClone(updated)
    },
    onCatalogChanged: () => noop
  },
  tags: { onChanged: () => noop },
  permissions: { list: async () => ({ grants: [] }), onChanged: () => noop }
} as unknown as typeof window.api
useSettingsStore.setState({
  ...createInitialSettingsState(),
  skills,
  skillsLoaded: true,
  ...connectors,
  connectorsLoaded: true
})
useSpecialistStore.setState({
  items: specialists.map((item) => ({ ...item, kind: 'custom' })),
  isLoaded: true,
  integrity: { status: 'ok' }
})
useTagStore.setState({
  ...createInitialTagState(),
  status: 'ready',
  revision: 1,
  load: async () => {},
  listen: () => noop
})

export const Fixture = (): React.JSX.Element => {
  const [view, setView] = useState<SkillsView>({ kind: 'list' })
  const [connectorView, setConnectorView] = useState<ConnectorsView>({ kind: 'list' })
  return (
    <TooltipProvider>
      <main className="mx-auto flex h-svh max-w-[880px] flex-col border-x border-border bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-5 text-sm font-medium">
          {connectorPage
            ? locale === 'en'
              ? 'Connectors'
              : '连接器'
            : locale === 'en'
              ? 'Skills'
              : '技能'}
          <button
            className="ml-auto"
            onClick={() => {
              setView({ kind: 'list' })
              setConnectorView({ kind: 'list' })
            }}
          >
            Back
          </button>
        </header>
        <div data-testid="catalog-scroll" className="min-h-0 flex-1 overflow-y-auto">
          {connectorPage ? (
            connectorView.kind === 'detail' ? (
              <ConnectorDetailView id={connectorView.id} onOpenSpecialist={noop} />
            ) : (
              <ConnectorsPanel onNavigate={setConnectorView} onOpenSpecialist={noop} />
            )
          ) : (
            <SkillsPanel view={view} onNavigate={setView} onOpenSpecialist={noop} />
          )}
        </div>
      </main>
    </TooltipProvider>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
