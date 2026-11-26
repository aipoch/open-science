import '@/assets/main.css'
import { initI18n, prepareI18nLocale } from '@/i18n'
import {
  LiteratureRendererProvider,
  type LiteratureRendererHost
} from '@/pages/literature/public/host'
import { LiteratureSynthesisWorkspace } from '@/pages/literature/synthesis/LiteratureSynthesisWorkspace'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  LiteratureSynthesisRequest,
  LiteratureSynthesisResult,
  SynthesisCandidate,
  SynthesisNote
} from '../../../src/shared/literature-synthesis'

// This fixture exercises the production React UI. Persistence, PDF preview and file saving below
// are explicit browser-test doubles and do not prove the main-process backend or PDF decoding.
const papers = [
  {
    id: 'paper-one',
    title: 'Paper One — reproducible methods',
    quote: 'First study reports the measured result.',
    tag: 'Methods'
  },
  {
    id: 'paper-two',
    title: 'Paper Two — independent evidence',
    quote: 'Second study reports an independent result.',
    tag: 'Evidence'
  }
]
const candidates: SynthesisCandidate[] = papers.map((paper, index) => ({
  itemId: paper.id,
  versionId: `version-${index}`,
  annotationId: `annotation-${index}`,
  bibliography: {
    itemId: paper.id,
    title: paper.title,
    authors: `Research group ${index + 1}`,
    year: '2026'
  },
  tags: [{ id: paper.tag.toLowerCase(), name: paper.tag }],
  annotation: {
    id: `annotation-${index}`,
    version: 1,
    origin: 'user',
    kind: 'highlight',
    color: 'yellow',
    tagIds: [paper.tag.toLowerCase()],
    note: `Comment on ${paper.tag.toLowerCase()}`,
    literatureVersionId: `version-${index}`,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    target: {
      source: {
        kind: 'literature-attachment-version',
        sourceFileId: `attachment-${index}`,
        versionId: `version-${index}`,
        checksum: 'a'.repeat(64),
        name: `${paper.id}.pdf`,
        path: `literature-attachment-version:version-${index}`
      },
      selector: {
        kind: 'text',
        pageNumber: index + 1,
        pageRotation: 0,
        coordinateVersion: 1,
        extractorVersion: 'fixture',
        exact: paper.quote,
        position: { start: 0, end: paper.quote.length },
        quads: [{ x: 0.1, y: 0.2, width: 0.7, height: 0.05 }]
      }
    }
  }
}))
const storageKey = 'synthesis-browser-fixture-notes'
let notes: SynthesisNote[] = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
const savedFiles: Array<{ name: string; text: string }> = []
const requests: LiteratureSynthesisRequest[] = []
const sources: string[] = []
const persist = (): void => localStorage.setItem(storageKey, JSON.stringify(notes))
const requiredNote = (id: string): SynthesisNote => {
  const note = notes.find((entry) => entry.id === id)
  if (!note) throw new Error('Fixture note missing')
  return structuredClone(note)
}
const transport = async (
  request: LiteratureSynthesisRequest
): Promise<LiteratureSynthesisResult> => {
  requests.push(structuredClone(request))
  if (request.action === 'list') return { action: 'list', notes: structuredClone(notes) }
  if (request.action === 'candidates')
    return {
      action: 'candidates',
      candidates: candidates.filter((candidate) => request.itemIds.includes(candidate.itemId))
    }
  if (request.action === 'read') return { action: 'read', note: requiredNote(request.noteId) }
  if (request.action === 'revision') {
    const note = requiredNote(request.noteId)
    return { action: 'revision', noteId: note.id, revision: note.revision }
  }
  if (request.action === 'source') {
    const block = requiredNote(request.noteId).blocks.find((entry) => entry.id === request.blockId)
    if (block?.type !== 'excerpt') throw new Error('Fixture excerpt missing')
    return { action: 'source', block }
  }
  if (request.action === 'delete') {
    notes = notes.filter((note) => note.id !== request.noteId)
    persist()
    return { action: 'delete', deleted: true }
  }
  if (request.action === 'export') {
    const note = requiredNote(request.noteId)
    if (note.revision !== request.expectedRevision) throw new Error('Fixture note changed')
    const markdown =
      `# ${note.title}\n\n` +
      note.blocks
        .map((block) =>
          block.type === 'heading'
            ? `${'#'.repeat(block.level)} ${block.text}`
            : block.type === 'text'
              ? block.text
              : `> ${'exact' in block.snapshot.annotation.target.selector ? block.snapshot.annotation.target.selector.exact : ''}\n\n${block.snapshot.bibliography.title}`
        )
        .join('\n\n')
    return { action: 'export', filename: 'fixture-synthesis.md', markdown }
  }
  const note: SynthesisNote =
    request.action === 'create'
      ? {
          id: crypto.randomUUID(),
          title: request.title,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          blocks: []
        }
      : requiredNote(request.noteId)
  if (request.action === 'update') {
    note.title = request.title
    note.blocks = request.blocks.map((block) =>
      block.type === 'excerpt' ? note.blocks.find((saved) => saved.id === block.id)! : block
    )
  } else {
    for (const selection of request.excerpts) {
      const snapshot = candidates.find(
        (candidate) => candidate.annotationId === selection.annotationId
      )!
      if (
        !note.blocks.some(
          (block) =>
            block.type === 'excerpt' && block.snapshot.annotationId === snapshot.annotationId
        )
      )
        note.blocks.push({
          type: 'excerpt',
          id: crypto.randomUUID(),
          snapshot: structuredClone(snapshot),
          sourceStatus: 'current'
        })
    }
  }
  if (request.action !== 'create') note.revision++
  notes = [note, ...notes.filter((entry) => entry.id !== note.id)]
  persist()
  return { action: request.action, note: structuredClone(note) }
}
const host = {
  api: {
    literature: {
      synthesis: transport,
      get: async (id: string) => ({
        item: { title: papers.find((paper) => paper.id === id)?.title ?? id }
      }),
      search: async () => ({
        entries: papers.map((paper) => ({ id: paper.id, item: { title: paper.title } }))
      })
    },
    saveBlobFile: async (file: { suggestedName: string; data: ArrayBuffer }) => {
      savedFiles.push({ name: file.suggestedName, text: new TextDecoder().decode(file.data) })
      return { saved: true }
    }
  },
  createBookmarkPreviewItem: (
    target: { id: string } & SynthesisCandidate['annotation']['target']
  ) => ({
    id: target.id,
    type: 'file',
    format: 'pdf',
    sessionId: 'fixture-library',
    title: target.source.name,
    name: target.source.name,
    path: target.source.path
  }),
  PdfAnnotationPreviewDialog: ({
    annotation,
    onClose
  }: ComponentProps<LiteratureRendererHost['PdfAnnotationPreviewDialog']>) => {
    sources.push(annotation.target.source.versionId)
    return (
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            aria-describedby={undefined}
            className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] space-y-4 p-6')}
          >
            <Dialog.Title>Source preview UI fixture</Dialog.Title>
            <p className="text-sm text-muted-foreground">
              Static source preview. PDF decoding and source permissions are not exercised.
            </p>
            <blockquote className="border-l-2 border-primary pl-3">
              {'exact' in annotation.target.selector ? annotation.target.selector.exact : ''}
            </blockquote>
            <p>{annotation.note}</p>
            <p>{annotation.target.source.versionId}</p>
            <Button onClick={onClose}>Close source preview</Button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
} as unknown as LiteratureRendererHost
;(window as unknown as { synthesisFixture: unknown }).synthesisFixture = {
  notes: () => structuredClone(notes),
  savedFiles: () => savedFiles,
  requests: () => requests,
  sources: () => sources
}
export function Fixture(): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [entry, setEntry] = useState<'create' | 'list'>()
  return (
    <LiteratureRendererProvider host={host}>
      <main className="min-h-dvh space-y-5 bg-background p-6 text-foreground">
        <h1 className="text-lg font-semibold">Synthesis notes UI fixture</h1>
        <p className="text-sm text-muted-foreground">
          Production editor with fixture storage and preview.
        </p>
        {papers.map((paper) => (
          <label key={paper.id} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={selected.includes(paper.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, paper.id]
                    : current.filter((id) => id !== paper.id)
                )
              }
            />
            {paper.title}
          </label>
        ))}
        <div className="flex flex-wrap gap-3">
          <Button disabled={!selected.length} onClick={() => setEntry('create')}>
            Create from selected papers
          </Button>
          <Button variant="outline" onClick={() => setEntry('list')}>
            Open synthesis notes
          </Button>
        </div>
        {entry ? (
          <LiteratureSynthesisWorkspace
            createFromSelection={entry === 'create'}
            resolveSelectedItemIds={async () => selected}
            onClose={() => setEntry(undefined)}
          />
        ) : null}
      </main>
    </LiteratureRendererProvider>
  )
}
void Promise.resolve(prepareI18nLocale('en')).then(() => {
  initI18n('en')
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
