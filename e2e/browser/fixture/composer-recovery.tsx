import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { WebEventRecoveryDialog } from '@/components/WebEventRecoveryDialog'
import { configureComposerDraftStorage } from '@/pages/workspace/composer-draft-storage'
import { WorkspaceComposerDraftsProvider } from '@/pages/workspace/workspace-composer-drafts'
import { useWorkspaceComposerController } from '@/pages/workspace/workspace-composer-controller'
import { docToText } from '@/pages/workspace/composer/composer-doc'
import type { WebEventConnectionPhase } from '../../../src/shared/web-event-connection'
import type { UploadedAttachment } from '../../../src/shared/uploads'

initI18n('en')
configureComposerDraftStorage('fixture-host/principal')
const attachment: UploadedAttachment = {
  id: 'completed',
  sessionId: '.pending',
  name: 'completed.txt',
  originalName: 'completed.txt',
  path: '/verified/completed.txt',
  size: 4,
  draftReceipt: 'fixture-receipt'
}
const uploads = {
  stageLocalFile: (file: File): Promise<UploadedAttachment> =>
    file.name === 'completed.txt' ? Promise.resolve(attachment) : new Promise(() => {}),
  claimLocalFile: async () => {},
  beginTransfer: async () => {
    throw new Error('not used')
  },
  appendTransfer: async () => {
    throw new Error('not used')
  },
  getTransferStatus: async () => null,
  finishTransfer: async () => attachment,
  abortTransfer: async () => {},
  deleteUpload: async () => {},
  recoverDraft: async ({ receipt }: { receipt: string }) =>
    receipt === 'fixture-receipt' ? attachment : null
}
Object.defineProperty(window, 'api', { value: { uploads }, configurable: true })
export const Harness = (): React.JSX.Element => {
  const [recovery, setRecovery] = useState<WebEventConnectionPhase>('live')
  const [project, setProject] = useState('project')
  const composer = useWorkspaceComposerController({
    currentDraftKey: `session-${project}`,
    newConversationDraftKey: `new:${project}`,
    activeProjectId: project,
    activeSession: { id: `session-${project}`, projectId: project },
    pendingCustomizePrefill: undefined,
    onCustomizePrefillApplied: () => {},
    historyEntries: [],
    historyPolicy: {
      catalogSkillIds: new Set(),
      allowedSkillIds: undefined,
      skillCatalogReady: true,
      refreshSkillCatalog: false,
      specialistCatalogReady: true,
      specialistId: undefined,
      loadSkills: async () => {},
      loadSpecialists: async () => {}
    },
    canStageAttachments: true,
    supportsImageInput: true,
    uploads
  })
  return (
    <main>
      <textarea
        aria-label="Draft"
        value={docToText(composer.view.doc)}
        onChange={(event) =>
          composer.actions.changeDoc({ nodes: [{ type: 'text', text: event.target.value }] })
        }
      />
      <button onClick={() => composer.actions.stageFiles([new File(['done'], 'completed.txt')])}>
        Complete upload
      </button>
      <button onClick={() => composer.actions.stageFiles([new File(['wait'], 'pending.txt')])}>
        Start upload
      </button>
      <button onClick={() => setRecovery('reload-required')}>Require reload</button>
      <button onClick={() => setRecovery('authorization-required')}>Require pairing</button>
      <button onClick={() => setProject(project === 'project' ? 'other' : 'project')}>
        Switch project
      </button>
      <button
        onClick={() => {
          Storage.prototype.setItem = () => {
            throw new Error('Storage unavailable')
          }
        }}
      >
        Block storage
      </button>
      <button
        onClick={() => {
          const snapshot = composer.lifecycle.captureSend()
          composer.lifecycle.clearDraft(snapshot.draftKey, snapshot.version)
        }}
      >
        Send
      </button>
      <div data-testid="attachments">
        {composer.view.attachments.map((file) => file.name).join(', ')}
      </div>
      <div data-testid="transfers">
        {composer.view.transfers
          .map((file) => `${file.name}: ${file.status} ${file.error ?? ''}`)
          .join(', ')}
      </div>
      <WebEventRecoveryDialog active={recovery !== 'live'} phase={recovery} />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <WorkspaceComposerDraftsProvider>
    <Harness />
  </WorkspaceComposerDraftsProvider>
)
