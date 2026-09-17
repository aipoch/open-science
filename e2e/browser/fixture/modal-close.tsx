import '@/assets/main.css'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SpecialistMarketplace } from '@/pages/settings/SpecialistMarketplace'
import { useMarketplaceStore } from '@/stores/marketplace-store'
import { LiteratureAttachments } from '@/pages/literature/LiteratureAttachments'
import { SkillEditLoader } from '@/pages/settings/SkillEditor'
import { MemoryPanel } from '@/pages/settings/MemoryPanel'
import { createInitialMemoryState, useMemoryStore } from '@/stores/memory-store'
import { initI18n } from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RepairFrameworkDialog } from '@/pages/settings/RepairFrameworkDialog'
import { SkillMarketplaceUpdateDialog } from '@/pages/settings/SkillMarketplaceUpdateDialog'
import { XaiOAuthSignInDialog } from '@/pages/settings/XaiOAuthSignInDialog'
import {
  CollectionEditorDialog,
  type CollectionEditorDialogHandle
} from '@/pages/literature/CollectionEditorDialog'
import { ArtifactLiteratureDetailDialog } from '@/pages/workspace/ArtifactLiteratureDetailDialog'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import { ProvidersPanel } from '@/pages/settings/ProvidersPanel'
import { ConnectorsPanel } from '@/pages/settings/ConnectorsPanel'
import { TagsPanel } from '@/pages/settings/TagsPanel'
import { SpecialistsPanel } from '@/pages/settings/SpecialistsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { literatureItemInputSchema } from '../../../src/shared/literature'

initI18n('en')
const noop = (): void => {}
const done = async (): Promise<void> => {}
let skillReads = 0
const skillDetail = {
  id: 'audit',
  name: 'audit',
  displayName: 'Audit Skill',
  description: 'Audit description',
  source: 'personal',
  updatedAt: '2026-09-17T00:00:00Z',
  enabled: true,
  body: 'Original body',
  metadata: {},
  references: [],
  packageFiles: [],
  etag: 'original'
}
window.api = {
  platform: 'darwin',
  settings: {
    getSkillDetail: async () => ({
      ...skillDetail,
      ...(++skillReads > 1 ? { etag: 'latest', body: 'Latest saved body' } : {})
    })
  },
  literature: { onChanged: () => noop, search: async () => ({ entries: [] }) },
  tags: { onChanged: () => noop },
  specialists: { list: async () => useSpecialistStore.getState().items }
} as unknown as Window['api']
useSettingsStore.setState({
  ...createInitialSettingsState(),
  updateSkill: async () => {
    throw new Error('This Skill changed. Reload it before saving.')
  },
  isLoaded: true,
  load: async () => true,
  skillsLoaded: true,
  connectorsLoaded: true,
  loadSkills: done,
  loadConnectors: done,
  providers: [
    {
      id: 'gateway',
      type: 'custom',
      name: 'Audit Gateway',
      models: ['audit-model'],
      model: 'audit-model',
      hasKey: true,
      needsKey: false,
      supportsImageInput: false
    }
  ],
  customServers: [
    {
      id: 'server',
      name: 'audit-mcp',
      displayName: 'Audit MCP',
      description: 'Local connector',
      transport: 'stdio',
      command: 'node',
      enabled: true,
      oauth: { hasTokens: true, sharedCredential: true }
    }
  ]
})
useSpecialistStore.setState({
  isLoaded: true,
  previewDelete: async () => ({
    specialistId: 'audit',
    specialistName: 'Audit Specialist',
    expectedRevision: 1,
    skills: []
  }),
  items: [
    {
      kind: 'custom',
      revision: 1,
      id: 'audit',
      name: 'audit',
      displayName: 'Audit Specialist',
      description: 'Audit specialist',
      systemPrompt: 'Research',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
    }
  ],
  load: done
})
useTagStore.setState({
  ...createInitialTagState(),
  status: 'ready',
  revision: 1,
  load: done,
  listen: () => noop,
  tags: [
    {
      id: 'audit-tag',
      name: 'Audit Tag',
      iconKey: 'book-open',
      colorKey: 'purple',
      createdAt: 1,
      updatedAt: 1
    }
  ],
  assignments: [
    { tagId: 'audit-tag', resourceType: 'catalog.specialist', resourceId: 'audit', createdAt: 1 }
  ]
})
useMemoryStore.setState({
  ...createInitialMemoryState(),
  status: 'ready',
  categories: [
    {
      id: 'category',
      name: 'Audit memory',
      guidance: '',
      autoRecall: true,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      entries: [
        {
          id: 'entry',
          categoryId: 'category',
          categoryName: 'Audit memory',
          projectId: null,
          projectName: null,
          content: 'Audit note',
          origin: 'user',
          revision: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
  ],
  selectedCategoryId: 'category'
})
const item = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Audit reference',
  abstract: 'The reference content must remain during dismissal.'
})
const preview = {
  token: 'audit',
  localSkillId: 'audit',
  displayName: 'Audit Skill',
  source: 'personal' as const,
  installedVersion: '1.0.0',
  localChanges: 'unknown' as const,
  mainEnabled: true,
  specialists: [{ id: 'audit', name: 'Audit Specialist' }],
  added: ['new.md'],
  modified: [],
  removed: [],
  differences: []
}
useMarketplaceStore.setState({
  snapshot: {
    sources: [
      {
        id: 'audit',
        kind: 'github',
        name: 'Audit Marketplace',
        repositoryUrl: 'https://github.com/example/audit',
        ref: 'main',
        trust: 'user-approved',
        keyId: 'audit',
        keyFingerprint: 'a'.repeat(64),
        removable: true
      }
    ],
    specialists: [],
    failures: []
  },
  refresh: done
})
const attachmentItem = {
  id: 'paper',
  metadataRevision: 1,
  item,
  projectIds: [],
  collectionIds: [],
  createdAt: 1,
  updatedAt: 1,
  attachments: [
    {
      id: 'attachment',
      kind: 'fullText' as const,
      title: 'Audit paper',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      versions: [2, 1].map((n) => ({
        id: `version-${n}`,
        versionNumber: n,
        filename: `paper-v${n}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 1024,
        checksum: String(n).repeat(64),
        pageCount: 1,
        availability: 'available' as const,
        createdAt: 1700000000000 + n
      }))
    }
  ]
}
const cancellationRequests: string[] = []
Object.assign(window, { cancellationRequests })
const mode = new URLSearchParams(location.search).get('case')
export function Fixture(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(0)
  const collection = useRef<CollectionEditorDialogHandle>(null)
  const close = (): void => {
    cancellationRequests.push(mode ?? '')
    setOpen(false)
    if (new URLSearchParams(location.search).has('reopen')) {
      requestAnimationFrame(() => {
        setOpening((value) => value + 1)
        setOpen(true)
      })
    }
  }
  return (
    <TooltipProvider>
      <main className="p-6 max-w-4xl mx-auto">
        {[
          'providers',
          'connectors',
          'oauth-connection',
          'tags',
          'specialists',
          'marketplace',
          'attachment-history',
          'attachment-remove',
          'memory',
          'skill-conflict'
        ].includes(mode ?? '') ? null : (
          <button
            onClick={() => {
              setOpen(true)
              setOpening((value) => value + 1)
              if (mode === 'collection') collection.current?.openCreate()
              if (mode === 'package')
                usePackageOperationStore
                  .getState()
                  .setImportError('Audit import failure: file is incomplete.')
            }}
          >
            Open audit
          </button>
        )}
        {mode === 'memory' && <MemoryPanel view={{ kind: 'list' }} onNavigate={noop} />}
        {mode === 'skill-conflict' && <SkillEditLoader skillId="audit" onDone={noop} />}
        {mode === 'xai' && (
          <XaiOAuthSignInDialog
            open={open}
            session={
              open && opening === 1
                ? {
                    userCode: 'AUDIT-CODE',
                    verificationUri: 'https://example.com/verify',
                    expiresAt: 1900000000000,
                    intervalSeconds: 5
                  }
                : undefined
            }
            onCancel={close}
          />
        )}
        {mode === 'marketplace' && (
          <SpecialistMarketplace view={{ kind: 'marketplace-sources' }} onNavigate={noop} />
        )}
        {(mode === 'attachment-history' || mode === 'attachment-remove') && (
          <LiteratureAttachments
            item={attachmentItem}
            readItem={async () => attachmentItem}
            onPreview={noop}
          />
        )}
        {mode === 'repair' && (
          <RepairFrameworkDialog
            name={open ? `Audit Agent ${opening}` : null}
            sources={[]}
            disabled={false}
            installing={false}
            npmAvailable={true}
            blockedInstallSources={{}}
            onCancel={close}
            onRepair={noop}
          />
        )}
        {mode === 'skill-update' && (
          <SkillMarketplaceUpdateDialog
            preview={open ? preview : undefined}
            version="2.0.0"
            pending={false}
            onCancel={close}
            onConfirm={noop}
          />
        )}
        {mode === 'collection' && (
          <button
            onClick={() =>
              collection.current?.openEdit({
                id: 'another',
                name: 'Another collection',
                description: 'Fresh description',
                revision: 1,
                itemCount: 0,
                createdAt: 1,
                updatedAt: 1
              })
            }
          >
            Edit another collection
          </button>
        )}
        {mode === 'collection' && <CollectionEditorDialog ref={collection} onSaved={noop} />}
        {mode === 'artifact' && (
          <ArtifactLiteratureDetailDialog
            snapshotOnly
            reference={open ? { itemId: 'audit', metadataRevision: 1, item } : undefined}
            onOpenChange={setOpen}
          />
        )}
        {mode === 'package' && <SessionPackageImportError />}
        {mode === 'providers' && (
          <ProvidersPanel
            onCreateProvider={noop}
            onEditProvider={noop}
            onBusyProviderChange={noop}
          />
        )}
        {(mode === 'connectors' || mode === 'oauth-connection') && (
          <ConnectorsPanel onNavigate={noop} />
        )}
        {mode === 'tags' && (
          <TagsPanel view={{ kind: 'list' }} onNavigate={noop} onOpenResource={noop} />
        )}
        {mode === 'specialists' && <SpecialistsPanel view={{ kind: 'list' }} onNavigate={noop} />}
      </main>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
