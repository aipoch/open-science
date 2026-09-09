import '@/assets/main.css'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent
} from '@/components/ui/message-scroller'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceMessageItem } from '@/pages/workspace/WorkspaceMessageItem'
import { ComposerEditor } from '@/pages/workspace/composer/ComposerEditor'
import {
  docToText,
  emptyDoc,
  type ComposerDoc,
  type ComposerCaretPosition
} from '@/pages/workspace/composer/composer-doc'
import {
  useWorkspaceComposerUploadController,
  type ComposerDraft
} from '@/pages/workspace/workspace-composer-upload-controller'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatMessage } from '@/stores/session-store'
import type { Annotation } from '../../../src/shared/annotations'
import type { SessionPdfContextSource } from '../../../src/shared/session-persistence'

initI18n('en')
useSettingsStore.setState({ skillsLoaded: true })
const noop = (): void => undefined
// Only external effects are stubbed. Copy, paste, rendering and draft undo are production code.
const unavailable = async (): Promise<never> => {
  throw new Error('Not used by the clipboard fixture')
}
const uploadApi = {
  beginTransfer: unavailable,
  appendTransfer: unavailable,
  finishTransfer: unavailable,
  abortTransfer: unavailable,
  getTransferStatus: unavailable,
  deleteUpload: unavailable
}
const parts: NonNullable<ChatMessage['parts']> = [
  {
    type: 'artifact',
    id: 'csv-file',
    sourceFileId: 'csv-file',
    versionId: 'csv-version',
    source: 'upload',
    name: 'volcano-plot.csv',
    path: 'uploads/plot.csv',
    mimeType: 'text/csv'
  },
  { type: 'text', text: ' ' },
  {
    type: 'artifact',
    id: 'xlsx-file',
    sourceFileId: 'xlsx-file',
    versionId: 'xlsx-version',
    source: 'upload',
    name: 'volcano-plot-differential-analysis.xlsx',
    path: 'uploads/analysis.xlsx'
  },
  { type: 'text', text: '\nCreate a volcano plot in R' }
]
const message: ChatMessage = {
  id: 'message',
  role: 'user',
  content: docToText({ nodes: parts }),
  parts,
  status: 'complete',
  eventIds: [],
  createdAt: 1788940800000,
  updatedAt: 1788940800000
}
const initialDraft: ComposerDraft = {
  doc: emptyDoc,
  annotations: [],
  attachments: [],
  attachmentTransfers: [],
  automaticReadingEnabled: false
}

export function ClipboardFixture(): React.JSX.Element {
  const [doc, setDoc] = useState(emptyDoc)
  const [caretRequest, setCaretRequest] = useState<{
    key: number
    position: ComposerCaretPosition
  }>()
  const docRef = useRef<ComposerDoc>(emptyDoc)
  const activeDraftKeyRef = useRef('draft')
  const draftsRef = useRef<Record<string, ComposerDraft>>({ draft: initialDraft })
  const annotationsRef = useRef<Annotation[]>([])
  const readingContextSourcesRef = useRef<SessionPdfContextSource[]>([])
  const automaticReadingEnabledRef = useRef(false)
  const controller = useWorkspaceComposerUploadController({
    initialDraft,
    activeDraftKeyRef,
    docRef,
    draftsRef,
    annotationsRef,
    readingContextSourcesRef,
    automaticReadingEnabledRef,
    setActiveDoc: (next) => {
      docRef.current = next
      setDoc(next)
    },
    setActiveAnnotations: noop,
    clearHistory: noop,
    markChanged: noop,
    requestCaret: (position) =>
      setCaretRequest((previous) => ({ key: (previous?.key ?? 0) + 1, position })),
    canStageAttachments: false,
    supportsImageInput: false,
    uploads: uploadApi,
    restoreReadingContextSources: noop,
    setActiveAutomaticReadingEnabled: noop
  })
  return (
    <TooltipProvider>
      <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-12 px-8 py-12">
        <header className="text-sm text-muted-foreground">
          Open Science · Message clipboard browser test
        </header>
        <MessageScrollerProvider>
          <div className="h-56">
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent>
                  <WorkspaceMessageItem
                    message={message}
                    projectId="project"
                    onPreviewArtifact={noop}
                    onPreviewUploadAttachment={noop}
                    onOpenSkillMention={noop}
                    onPreviewMentionArtifact={noop}
                  />
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </div>
        </MessageScrollerProvider>
        <section className="rounded-2xl border border-border bg-bg-000 p-5 shadow-sm">
          <ComposerEditor
            doc={doc}
            onDocChange={controller.actions.changeDoc}
            onSubmit={noop}
            onPaste={noop}
            placeholder="Ask anything"
            ariaLabel="Ask anything"
            onUndo={controller.actions.undo}
            onRedo={controller.actions.redo}
            caretRequest={caretRequest}
            mentionPreviewContext={{
              projectId: new URLSearchParams(location.search).get('project') ?? 'project',
              sessionId: 'target'
            }}
          />
        </section>
        <output hidden data-testid="draft">
          {JSON.stringify(doc)}
        </output>
      </main>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<ClipboardFixture />)
