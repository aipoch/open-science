import '@/assets/main.css'
import '@/office-preview/office-preview.css'
import '@/components/global-search/global-search.css'
import { SearchDetails } from '@/components/global-search/SearchDetails'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { zipSync, strToU8 } from 'fflate'
import { initI18n } from '@/i18n'
import { ActionMenuProvider, ActionMenuTarget } from '@/components/action-menu'
import { PreviewActionMenuAdapterProvider } from '@/pages/workspace/preview-actions/preview-action-adapter'
import {
  PREVIEW_CAPABILITY_CATALOG,
  type PreviewCapabilityId
} from '@/pages/workspace/preview-actions/preview-action-model'
import { LocalFileHeaderActions } from '@/pages/workspace/LocalFileHeaderActions'
import { SessionReviewerPanel } from '@/pages/workspace/SessionReviewerPanel'
import { renderOfficeFile } from '@/pages/workspace/previews/office-renderers'
import type { ReviewWithChecks } from '../../../src/shared/reviewer'

import { ReplayControls } from '@/pages/workspace/replay/ReplayControls'
import { JournalColumnEditor } from '@/pages/literature/journals/JournalColumnEditor'
import { PdfNotebookView } from '@/pages/workspace/previews/renderers/PdfNotebookView'
import {
  PdfAnnotationsContext,
  type PdfAnnotationPort
} from '@/pages/workspace/pdf-annotations/pdf-annotations-context'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { SkillsPanel } from '@/pages/settings/SkillsPanel'
import { SpecialistsPanel } from '@/pages/settings/SpecialistsPanel'
import type { PdfAnnotation } from '../../../src/shared/pdf-annotations'
import type { JournalField } from '@aipoch/journal-catalog/contracts'

initI18n('en')
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).has('dark'))
const project = {
  id: 'project',
  name: 'Verification project',
  description: '',
  isExample: false,
  createdAt: 1000,
  updatedAt: 1001
}
const noop = (): void => {}
window.api = {
  platform: 'darwin',
  projectFiles: {
    getOverview: async () => ({
      totalCount: 1,
      uploadCount: 1,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    }),
    searchArtifacts: async () => ({
      primary: {
        items: [
          {
            id: 'file',
            source: 'upload',
            sourceFileId: 'file',
            sourceVersionId: 'version',
            projectId: 'project',
            sessionId: 'standalone-uploads',
            name: 'verification.data',
            path: '/verification.data',
            size: 24,
            sortAtMs: 1000
          }
        ],
        totalCount: 1
      },
      other: [],
      isIndexComplete: true
    })
  }
} as unknown as typeof window.api
const review: ReviewWithChecks = {
  id: 'review',
  projectId: 'project',
  sessionId: 'session',
  turnMessageId: 'turn',
  scope: { turnMessageId: 'turn', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: 'flagged',
  model: 'Review model',
  checks: [],
  reviewerLog: [],
  createdAt: 1000,
  updatedAt: 1001,
  errorMessage: 'Recorded review failure'
}
const documentBytes = zipSync({
  '[Content_Types].xml': strToU8(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  ),
  '_rels/.rels': strToU8(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  ),
  'word/document.xml': strToU8(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office preview theme verification</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
  )
})
export function Fixture(): React.JSX.Element {
  const office = useRef<HTMLDivElement>(null)
  const [actions, setActions] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let dispose: (() => void | Promise<void>) | undefined
    void renderOfficeFile({
      bytes: documentBytes,
      extension: 'docx',
      name: 'verification.docx',
      container: office.current!,
      signal: controller.signal
    }).then((cleanup) => {
      dispose = cleanup
    })
    return () => {
      controller.abort()
      void dispose?.()
    }
  }, [])
  return (
    <main className="space-y-6 bg-bg-10 p-6 text-text-000">
      <h1>UI consistency verification</h1>
      <ActionMenuProvider>
        <PreviewActionMenuAdapterProvider targetId="ui-verification">
          <ActionMenuTarget<PreviewCapabilityId, undefined>
            targetId="ui-verification"
            identityKey="verification"
            catalog={PREVIEW_CAPABILITY_CATALOG}
            recipe={[{ kind: 'action', action: 'copy-path' }]}
            bindings={{ 'copy-path': { execute: () => setActions((n) => n + 1) } }}
            invocation={undefined}
            asChild
          >
            <div className="flex items-center gap-2">
              <LocalFileHeaderActions
                path="/verification.docx"
                name="verification.docx"
                saveAsArtifactState="idle"
                onReload={() => setActions((n) => n + 1)}
              />
            </div>
          </ActionMenuTarget>
        </PreviewActionMenuAdapterProvider>
      </ActionMenuProvider>
      <button type="button">Outside action</button>
      <output aria-label="Action count">{actions}</output>
      <section className="h-60 rounded-md border border-border bg-bg-000" data-testid="reviewer">
        <SessionReviewerPanel review={review} historical activeFindingId={undefined} />
      </section>
      <section className="h-80 overflow-auto" data-testid="search-details">
        <SearchDetails
          result={{ kind: 'projects', item: project }}
          query=""
          projects={[project]}
          sessions={[]}
          onOpen={noop}
          onLocateFile={noop}
          onNavigate={noop}
          onCollapse={noop}
          onPreviewOpenChange={noop}
        />
      </section>
      <div ref={office} data-testid="office" className="h-96 overflow-auto" />
    </main>
  )
}

const annotation: PdfAnnotation = {
  id: 'annotation',
  projectId: 'project',
  sessionId: 'session',
  version: 1,
  origin: 'user',
  target: {
    source: {
      kind: 'literature-attachment-version',
      projectId: 'project',
      sourceFileId: 'file',
      versionId: 'version',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'literature-attachment-version:version'
    },
    selector: { kind: 'document-note', coordinateVersion: 1 }
  },
  kind: 'document-note',
  color: undefined,
  tagIds: [],
  note: 'Review this claim.',
  createdAt: '2026-10-12T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z'
}
const journalFields: JournalField[] = [
  { id: 'category', label: 'Category', kind: 'singleSelect', visible: true, colors: {} }
]
const specialist = {
  kind: 'custom' as const,
  id: 'reviewer',
  name: 'REVIEWER',
  displayName: 'Reviewer',
  description: '',
  systemPrompt: '',
  enabled: true,
  capabilityMode: 'selected' as const,
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  ownedSkillIds: ['mine'],
  revision: 1
}
if (new URLSearchParams(location.search).has('interactions')) {
  useTagStore.setState({
    ...createInitialTagState(),
    status: 'ready',
    tags: [
      {
        id: 'important',
        name: 'Important',
        iconKey: 'tag',
        colorKey: 'blue',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [
      {
        id: 'mine',
        name: 'Mine',
        displayName: 'Mine',
        description: 'Custom',
        source: 'personal',
        updatedAt: '2026-10-12T00:00:00Z',
        enabled: true
      }
    ],
    loadSkills: async () => {},
    deleteSkill: async () => {}
  })
  useSpecialistStore.setState({
    items: [specialist],
    isLoaded: true,
    load: async () => {},
    previewDelete: async () => ({
      specialistId: 'reviewer',
      specialistName: 'Reviewer',
      expectedRevision: 1,
      skills: [
        {
          id: 'main',
          displayName: 'Main enabled Skill',
          source: 'personal',
          kind: 'main-enabled',
          deletable: false,
          reasons: [{ code: 'main-enabled', specialistIds: [] }]
        }
      ]
    })
  })
}
export function InteractionFixture(): React.JSX.Element {
  const [note, setNote] = useState(annotation)
  const [identity, setIdentity] = useState({ issn: true, externalIds: true })
  const [fields, setFields] = useState<JournalField[] | undefined>(journalFields)
  const [choiceField, setChoiceField] = useState('')
  const [choiceQuery, setChoiceQuery] = useState('')
  const [choiceOffset, setChoiceOffset] = useState(0)
  const port: PdfAnnotationPort = {
    scoped: true,
    available: true,
    loading: false,
    annotations: [note],
    forSource: () => [note],
    forPage: () => [note],
    total: 1,
    retryLoad: noop,
    history: () => ({ canUndo: false, canRedo: false, busy: false }),
    undo: async () => {},
    redo: async () => {},
    create: async () => note,
    remove: async () => true,
    update: async (_, input) => {
      const next = {
        ...note,
        ...input,
        color: input.color === null ? undefined : (input.color ?? note.color),
        tagIds: input.tagIds ? [...input.tagIds] : note.tagIds
      }
      setNote(next)
      return next
    }
  }
  return (
    <main className="space-y-8 bg-bg-10 p-6 text-text-000">
      <section data-testid="pdf-notes">
        <PdfAnnotationsContext value={port}>
          <PdfNotebookView source={annotation.target.source} active />
        </PdfAnnotationsContext>
      </section>
      <section data-testid="replay">
        <ReplayControls
          playing={false}
          ready
          positionMs={0}
          durationMs={1000}
          stepIndex={0}
          steps={[
            {
              id: 'step',
              kind: 'activity',
              branchId: 'branch',
              title: 'Recorded step',
              evidence: [],
              activities: [],
              runs: [],
              resourceIds: [],
              issues: [],
              startMs: 0,
              durationMs: 1000,
              endMs: 1000
            }
          ]}
          speed={1}
          onPause={noop}
          onOpenEvidence={noop}
          onToggle={noop}
          onPrevious={noop}
          onNext={noop}
          onSeek={noop}
          onSpeed={noop}
          onAsk={noop}
        />
      </section>
      <section data-testid="journal">
        <JournalColumnEditor
          identityDraft={identity}
          setIdentityDraft={setIdentity}
          busy={false}
          fieldDraft={fields}
          setFieldDraft={setFields}
          moveField={noop}
          kinds={{
            text: 'Text',
            number: 'Number',
            singleSelect: 'Category',
            multiSelect: 'Categories'
          }}
          choiceField={choiceField}
          setChoiceField={setChoiceField}
          choiceResult={undefined}
          choiceQuery={choiceQuery}
          setChoiceQuery={setChoiceQuery}
          choiceOffset={choiceOffset}
          setChoiceOffset={setChoiceOffset}
          setChoicePage={noop}
          dataset={{
            id: 'journal',
            source: 'Test',
            year: 2026,
            revision: 1,
            fields: journalFields,
            count: 0,
            importedAt: 1
          }}
          colors={{
            gray: 'Gray',
            red: 'Red',
            orange: 'Orange',
            amber: 'Amber',
            green: 'Green',
            blue: 'Blue',
            purple: 'Purple',
            pink: 'Pink'
          }}
          remoteDatasets={[]}
          saveFields={async () => {}}
        />
      </section>
      <section data-testid="skills">
        <SkillsPanel view={{ kind: 'list' }} onNavigate={noop} />
      </section>
      <section data-testid="specialists">
        <SpecialistsPanel view={{ kind: 'list' }} onNavigate={noop} />
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('interactions') ? <InteractionFixture /> : <Fixture />
)
