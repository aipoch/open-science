import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'SettingsPage.tsx'), 'utf8')
const boundarySource = readFileSync(resolve(__dirname, 'SettingsPanelLoadingBoundary.tsx'), 'utf8')

describe('SettingsPage loading boundaries', () => {
  it('keeps Model eager and lazy-loads every other top-level Settings panel', () => {
    expect(source).toContain("import { ProvidersPanel } from './ProvidersPanel'")
    expect(source).toContain("import { ProviderForm } from './ProviderForm'")

    for (const panel of [
      'AgentPanel',
      'GeneralPanel',
      'NetworkPanel',
      'StoragePanel',
      'RuntimesPanel',
      'RemoteControlPanel',
      'SkillsPanel',
      'ConnectorsPanel',
      'SpecialistsPanel',
      'TagsPanel',
      'ConnectorDetailView',
      'ConnectorAddForm',
      'ConnectorExportView',
      'ConnectorImportView',
      'ComputePanel',
      'ComputeAddForm',
      'ComputeHostDetail',
      'PermissionsPanel',
      'ArchivedPanel',
      'TokenUsagePanel'
    ]) {
      expect(source).toContain(`const ${panel} = lazy(`)
      expect(source).not.toContain(`import { ${panel} } from`)
    }

    expect(source).toContain('<SettingsPanelLoadingBoundary')
    expect(boundarySource).toContain('<Suspense')
    expect(boundarySource).toContain('min-h-[360px]')
  })

  it('preloads initial panel data behind the same lazy-loading boundary', () => {
    for (const load of [
      'loadStatus()',
      'useRuntimeSettingsStore.getState().load()',
      'RemoteControlPanel.preload()',
      'useSettingsStore.getState().loadSkills()',
      'useSettingsStore.getState().loadConnectors()',
      'useSpecialistStore.getState().load()',
      'preloadComputeHosts()',
      'usePermissionGrantsStore.getState().load()'
    ]) {
      expect(source).toContain(load)
    }
  })
})
