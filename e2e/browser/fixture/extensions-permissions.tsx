import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { SkillUploadView } from '@/pages/settings/SkillUploadView'
import { PermissionsPanel } from '@/pages/settings/PermissionsPanel'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  PermissionGrantSnapshot,
  PermissionGrantRevokeRequest
} from '../../../src/shared/permission-grants'

initI18n('en')
let snapshot: PermissionGrantSnapshot = {
  version: 1,
  incompleteStores: [],
  missingDefaultGlobalGrantCount: 0,
  counts: { all: 2, global: 1, project: 0, session: 1 },
  grants: [
    {
      id: 'global',
      revision: 1,
      family: 'connectors',
      capabilityKind: 'mcp_tool',
      capabilityLabel: 'Search',
      qualifierLabel: '',
      scopeKind: 'global',
      scopeLabel: 'Global',
      connectorServerId: 'fixture',
      connectorDisplayName: 'Research Connector',
      connectorToolName: 'search',
      effectiveState: 'active',
      createdAt: Date.UTC(2026, 8, 10)
    },
    {
      id: 'session',
      revision: 1,
      family: 'connectors',
      capabilityKind: 'mcp_tool',
      capabilityLabel: 'Search',
      qualifierLabel: '',
      scopeKind: 'session',
      scopeLabel: 'Session: Analysis',
      projectId: 'project',
      sessionId: 'session',
      connectorServerId: 'fixture',
      connectorDisplayName: 'Research Connector',
      connectorToolName: 'search',
      effectiveState: 'active',
      coveredBy: 'global'
    }
  ]
}
const imports: unknown[] = []
Object.assign(window, { extensionRegression: { imports } })
window.api = {
  platform: 'darwin',
  permissions: {
    list: async () => structuredClone(snapshot),
    revoke: async (request: PermissionGrantRevokeRequest) => {
      snapshot = {
        ...snapshot,
        version: snapshot.version + 1,
        grants: snapshot.grants.filter(
          (grant) => !request.grants.some((item) => item.id === grant.id)
        )
      }
      snapshot.counts = {
        all: snapshot.grants.length,
        global: snapshot.grants.filter((grant) => grant.scopeKind === 'global').length,
        project: 0,
        session: snapshot.grants.filter((grant) => grant.scopeKind === 'session').length
      }
      return { ...structuredClone(snapshot), conflicts: [] }
    }
  }
} as unknown as typeof window.api
useSettingsStore.setState({
  skills: [],
  previewSkillZip: async () => ({
    previews: [
      {
        subPath: 'citation',
        name: 'Citation',
        description: 'Replacement candidate',
        metadata: {},
        body: 'New instructions',
        files: ['SKILL.md', 'new.txt'],
        alreadyImported: false,
        replaceableId: 'imported-citation',
        replacement: {
          targetId: 'imported-citation',
          sourceLabel: 'github.com/acme/skills@main/citation',
          added: ['new.txt'],
          modified: ['SKILL.md'],
          removed: ['local-notes.txt']
        }
      }
    ],
    skipped: []
  }),
  importSkillZipBatch: async (dataBase64, items) => {
    imports.push({ dataBase64, items })
    return {
      results: items.map((item) => ({
        subPath: item.subPath,
        id: 'imported-citation',
        status: 'updated' as const
      })),
      skills: []
    }
  }
})
export function Fixture(): React.JSX.Element {
  const [mode, setMode] = useState<'skills' | 'permissions'>('skills')
  return (
    <main className="mx-auto max-w-3xl bg-card text-foreground p-4">
      <nav className="flex gap-4 mb-4">
        <button onClick={() => setMode('skills')}>Skills fixture</button>
        <button onClick={() => setMode('permissions')}>Permissions fixture</button>
      </nav>
      {mode === 'skills' ? (
        <SkillUploadView onUploaded={() => {}} onWriteInstead={() => {}} />
      ) : (
        <PermissionsPanel />
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
