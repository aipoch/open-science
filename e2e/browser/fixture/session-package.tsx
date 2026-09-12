import {
  ActionMenuItems,
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenuTarget
} from '@/components/action-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import {
  SESSION_ACTION_CATALOG,
  SESSION_ACTION_RECIPE,
  createSessionActionBindings,
  type SessionActionId
} from '@/pages/workspace/session-action-menu'
import type { ChatSession } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import type { PackageOperationSnapshot } from '../../../src/shared/session-package'
import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { SessionPackageOperation } from '@/components/SessionPackageOperation'
import { usePackageOperationStore } from '@/stores/package-operation-store'

initI18n('en')
const empty = new URLSearchParams(location.search).has('empty')
usePackageOperationStore.getState().receive({
  id: 'layout-fixture',
  kind: 'export',
  state: 'awaiting-selection',
  session: { projectId: 'fixture', sessionId: 'fixture' },
  progress: { phase: 'selecting' },
  summary: { metadataBytes: 7987, retainedFiles: [] },
  files: empty
    ? []
    : Array.from({ length: 30 }, (_, index) => ({
        source: 'artifact',
        groupId: `result-${index}`,
        filename: `research-result-${index}.csv`,
        storageKey: `artifacts/fixture/fixture/result-${index}`,
        sizeBytes: 1024 * (index + 1),
        versionNumber: 1,
        requiredForEvidence: index === 0,
        dependentFiles: []
      }))
})
const mode = new URLSearchParams(location.search).get('import')
if (mode) {
  const projects = [
    {
      id: 'cancer',
      name: 'Cancer immunotherapy',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'materials',
      name: 'Biomaterials research',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
  ]
  const preview = {
    title: 'Nanomaterials and tumour immunity',
    projectName: 'Source research',
    branchCount: 2,
    messageCount: 24,
    fileCount: 8,
    totalBytes: 42 * 1024 ** 2,
    omissions: [
      {
        kind: 'excluded' as const,
        description:
          'Account credentials, permission grants and provider continuation identities are excluded.'
      },
      {
        kind: 'external' as const,
        description: 'Files left on remote Compute hosts are not included.'
      }
    ]
  }
  const operation: PackageOperationSnapshot = {
    id: 'import-fixture',
    kind: 'import',
    state:
      mode === 'error'
        ? 'failed'
        : mode === 'cleanup'
          ? 'succeeded'
          : mode === 'progress'
            ? 'running'
            : 'awaiting-selection',
    error: mode === 'error' ? 'The package could not be imported.' : undefined,
    cleanupPending: mode === 'cleanup',
    importQueueFull: new URLSearchParams(location.search).has('queue-full'),
    importRequestId: 'file-open',
    importFilename: 'tumour-immunity.science',
    importTarget: mode === 'project' ? undefined : { projectId: 'cancer' },
    importPreview: mode === 'review' ? preview : undefined,
    progress:
      mode === 'error' || mode === 'cleanup'
        ? { phase: mode === 'cleanup' ? 'cleaning' : 'importing' }
        : mode === 'progress'
          ? { phase: 'importing', completedBytes: 18 * 1024 ** 2, totalBytes: 42 * 1024 ** 2 }
          : { phase: mode === 'review' ? 'confirming' : 'selecting' },
    pendingImports: [{ id: 'next', filename: 'follow-up-study.science' }]
  }
  useProjectStore.setState({
    projects,
    isLoaded: true,
    loadProjects: async () => undefined,
    createProject: async ({ name }) => {
      const project = {
        id: 'created',
        name,
        description: '',
        isExample: false,
        createdAt: 2,
        updatedAt: 2
      }
      useProjectStore.getState().upsertProject(project)
      return project
    }
  })
  // This browser fixture owns only renderer interaction. Native file receipt is covered by main tests.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sessions: {
        packageOperation: async (request: {
          action: string
          target?: { projectId?: string; projectName?: string }
          requestId?: string
        }) => {
          if (request.action === 'discard-import')
            operation.pendingImports = operation.pendingImports?.filter(
              (file) => file.id !== request.requestId
            )
          if (request.action === 'select-project')
            Object.assign(operation, {
              importTarget: request.target,
              importPreview: preview,
              progress: { phase: 'confirming' }
            })
          if (request.action === 'confirm-import')
            Object.assign(operation, {
              state: 'running',
              importPreview: undefined,
              progress: {
                phase: 'importing',
                completedBytes: 18 * 1024 ** 2,
                totalBytes: 42 * 1024 ** 2
              }
            })
          usePackageOperationStore.getState().receive({ ...operation })
          return operation
        }
      }
    }
  })
  usePackageOperationStore.getState().receive(operation)
}
const menuMode = new URLSearchParams(location.search).has('menu')
if (menuMode) usePackageOperationStore.getState().setOpen(false)
const menuSession: ChatSession = {
  id: 'fixture',
  projectId: 'fixture',
  title: 'Nanomaterials and tumour immunity',
  cwd: '',
  status: 'idle',
  messages: [],
  activeMessageCount: 24,
  createdAt: 1,
  updatedAt: 1
}
const noop = (): void => undefined
const MenuContents = (): React.JSX.Element => {
  const menu = useActionMenuTarget<SessionActionId>()
  return (
    <ActionMenuItems
      entries={menu.entries}
      onSelect={(action) => void menu.execute(action)}
      compact={false}
    />
  )
}
export const SessionMenuFixture = (): React.JSX.Element => (
  <div className="p-12">
    <ActionMenuProvider>
      <ActionMenuTarget
        asChild
        targetId="fixture-session"
        identityKey="fixture"
        invocation={{ session: menuSession, presentedStatus: menuSession.status }}
        catalog={SESSION_ACTION_CATALOG}
        recipe={SESSION_ACTION_RECIPE}
        bindings={createSessionActionBindings({
          canMutateConversations: true,
          canDeleteConversations: true,
          canDownloadArtifacts: true,
          onTogglePin: noop,
          onRenameSession: noop,
          onDownloadArtifacts: noop,
          onViewNotebook: noop,
          onExportSession: noop,
          onExportPackage: async () => {
            usePackageOperationStore.getState().setOpen(true)
          },
          onDeleteSession: noop
        })}
      >
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Session menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <MenuContents />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ActionMenuTarget>
    </ActionMenuProvider>
  </div>
)
createRoot(document.getElementById('root')!).render(
  <>
    {menuMode ? <SessionMenuFixture /> : null}
    <SessionPackageOperation />
  </>
)
