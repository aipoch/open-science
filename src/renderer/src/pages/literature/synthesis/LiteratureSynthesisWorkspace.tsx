import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, GripVertical, MoreHorizontal, X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogCloseButtonClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  annotationQuote,
  synthesisNoteSummary,
  type LiteratureSynthesisResult,
  type SynthesisBlock,
  type SynthesisCandidate,
  type SynthesisNote,
  type SynthesisSourceMetadata
} from '../../../../../shared/literature-synthesis'
import { useLiteratureHost, type LiteraturePreviewItem } from '../renderer-host'
import { SynthesisCandidates } from './SynthesisCandidates'
import { SynthesisReferenceSearch } from './SynthesisReferenceSearch'
import {
  createSynthesisMutationIdentity,
  editableBlocks,
  insertSynthesisBlock,
  moveSynthesisBlock,
  readSynthesisCandidates
} from './synthesis-state'

type Summary = Extract<LiteratureSynthesisResult, { action: 'list' }>['notes'][number]

function noteSearchContent(entry: Summary): string {
  const metadataValues = new Set(
    (entry.sourceMetadata ?? []).flatMap((source) => [source.title, source.authors, ...source.tags])
  )
  return (entry.searchText ?? '')
    .split(/\r?\n/)
    .filter(
      (line) => line.trim() && line.trim() !== entry.title && !metadataValues.has(line.trim())
    )
    .join(' ')
}

function noteSearchSnippet(entry: Summary, keyword: string): string | undefined {
  const text = noteSearchContent(entry).replace(/\s+/g, ' ').trim()
  const matchIndex = text.toLowerCase().indexOf(keyword.replace(/\s+/g, ' '))
  if (matchIndex < 0) return undefined
  const start = Math.max(0, matchIndex - 45)
  const end = Math.min(text.length, start + 180)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function noteSearchMetadata(entry: Summary, keyword: string): SynthesisSourceMetadata[] {
  if (!entry.sourceMetadata?.length) return []
  const normalized = keyword.replace(/\s+/g, ' ')
  return entry.sourceMetadata.filter((source) =>
    [source.title, source.authors, ...source.tags].some((value) =>
      value.toLowerCase().includes(normalized)
    )
  )
}

type CandidateState = {
  itemIds: string[]
  candidates: SynthesisCandidate[]
  titles: Record<string, string>
}
type RemovedBlock = {
  noteId: string
  block: SynthesisBlock
  index: number
  previousId?: string
  nextId?: string
}
const blockDragType = 'application/x-open-science-synthesis-block'

function renderExcerptQuote(snapshot: SynthesisCandidate): React.JSX.Element | null {
  const quote = annotationQuote(snapshot.annotation.target.selector)
  return quote ? (
    <blockquote className="whitespace-pre-wrap border-l-2 border-primary/40 pl-3">
      {quote}
    </blockquote>
  ) : null
}

function overallAnalysisBlock(blocks: SynthesisBlock[]): SynthesisBlock | undefined {
  let followsExcerpt = false
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!followsExcerpt) return block
    } else followsExcerpt = block.type === 'excerpt'
  }
  return undefined
}

export function LiteratureSynthesisWorkspace({
  createFromSelection = false,
  resolveSelectedItemIds,
  onClose
}: {
  createFromSelection?: boolean
  resolveSelectedItemIds(): Promise<string[]>
  onClose(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api, createBookmarkPreviewItem, PdfAnnotationPreviewDialog } = useLiteratureHost()
  const [identifyMutation] = useState(createSynthesisMutationIdentity)
  const pendingAppends = useRef(new Map<string, ReturnType<typeof identifyMutation>>())
  const unconfirmedSaves = useRef(new Map<string, { noteId: string; expectedRevision: number }>())
  const [notes, setNotes] = useState<Summary[]>([])
  const [notesQuery, setNotesQuery] = useState('')
  const notesKeyword = notesQuery.trim().toLowerCase()
  const shownNotes = notes.flatMap((entry) => {
    const matchingMetadata = notesKeyword ? noteSearchMetadata(entry, notesKeyword) : []
    if (
      notesKeyword &&
      !matchingMetadata.length &&
      !entry.title.toLowerCase().includes(notesKeyword) &&
      !(entry.searchText ?? '').toLowerCase().includes(notesKeyword)
    )
      return []
    return [{ entry, matchingMetadata }]
  })
  const [note, setNote] = useState<SynthesisNote>()
  const [saved, setSaved] = useState<SynthesisNote>()
  const [removedBlock, setRemovedBlock] = useState<RemovedBlock>()
  const undoNotice = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'list' | 'editor' | 'candidates'>('list')
  const [candidateState, setCandidateState] = useState<CandidateState>()
  const [candidateDirty, setCandidateDirty] = useState(false)
  const [appendTarget, setAppendTarget] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [leave, setLeave] = useState<() => void>()
  const leaveInitiator = useRef<HTMLElement | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Summary>()
  const [preview, setPreview] = useState<{
    candidate: SynthesisCandidate
    item: LiteraturePreviewItem
  }>()
  const [retry, setRetry] = useState<() => void>()
  const previewInitiator = useRef<HTMLButtonElement | null>(null)
  const previewInitiatorBlockId = useRef<string | undefined>(undefined)
  const focusPreviewInitiator = (): void => {
    const initiator = previewInitiator.current
    if (initiator?.isConnected) {
      initiator.focus()
      return
    }
    const blockId = previewInitiatorBlockId.current
    if (blockId) {
      document
        .querySelector<HTMLButtonElement>(`[data-synthesis-source-block="${blockId}"]`)
        ?.focus()
    }
  }
  const restorePreviewFocus = useCallback((): void => {
    let frames = 0
    const focusWhenPreviewUnmounts = (): void => {
      const previewDialog = document.querySelector('[data-slot="file-preview-dialog"]')
      if (!previewDialog || frames >= 60) {
        setTimeout(focusPreviewInitiator, 0)
        return
      }
      frames += 1
      requestAnimationFrame(focusWhenPreviewUnmounts)
    }
    requestAnimationFrame(focusWhenPreviewUnmounts)
  }, [])
  const analysisInput = useRef<HTMLTextAreaElement>(null)
  const analysisBlockId = note
    ? (overallAnalysisBlock(note.blocks)?.id ??
      note.blocks.find((block) => block.type === 'text')?.id)
    : undefined
  const editorFocusPending = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const blockElements = useRef(new Map<string, HTMLLIElement>())
  const blockDrag = useRef<{ noteId: string; blockId: string } | undefined>(undefined)
  const [draggedBlockId, setDraggedBlockId] = useState<string>()
  const [dropBoundary, setDropBoundary] = useState<number>()
  const previewBlockDrop = (event: React.DragEvent<HTMLOListElement>): void => {
    const drag = blockDrag.current
    if (
      busy ||
      !drag ||
      !note ||
      drag.noteId !== note.id ||
      !event.dataTransfer.types.includes(blockDragType)
    )
      return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    // Resolve a boundary from the whole list, including the gaps between blocks.
    const boundary = note.blocks.findIndex((entry) => {
      const rect = blockElements.current.get(entry.id)?.getBoundingClientRect()
      return rect && event.clientY < rect.top + rect.height / 2
    })
    setDropBoundary(boundary < 0 ? note.blocks.length : boundary)
  }

  const clearBlockDrag = (): void => {
    blockDrag.current = undefined
    setDraggedBlockId(undefined)
    setDropBoundary(undefined)
  }
  const blockFocusPending = useRef<string | undefined>(undefined)
  const [transientEmptyBlocks, setTransientEmptyBlocks] = useState(new Set<string>())
  const isTransientEmptyBlock = (block: SynthesisBlock): boolean =>
    transientEmptyBlocks.has(block.id) &&
    (block.type === 'text' || block.type === 'heading') &&
    !block.text.trim()
  const draftBlockCount = (blocks: SynthesisBlock[]): number =>
    blocks.filter((block) => !isTransientEmptyBlock(block)).length
  const editableDraftBlocks = (blocks: SynthesisBlock[]): ReturnType<typeof editableBlocks> =>
    editableBlocks(blocks.filter((block) => !isTransientEmptyBlock(block)))
  const blockLimitReached = Boolean(note && draftBlockCount(note.blocks) >= 200)
  const draftFingerprint = (value: SynthesisNote): string =>
    JSON.stringify({ title: value.title, blocks: editableDraftBlocks(value.blocks) })
  const dirty = Boolean(note && saved && draftFingerprint(note) !== draftFingerprint(saved))
  const hasUnsavedChanges = dirty || (mode === 'candidates' && candidateDirty)
  const noteRef = useRef(note)
  const dirtyRef = useRef(dirty)
  useLayoutEffect(() => {
    noteRef.current = note
    dirtyRef.current = dirty
  }, [note, dirty])
  const alive = useRef(true)
  useEffect(() => {
    if (busy || mode !== 'editor' || blockDrag.current?.noteId !== note?.id) {
      blockDrag.current = undefined
      setDraggedBlockId(undefined)
      setDropBoundary(undefined)
    }
  }, [busy, mode, note?.id])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [hasUnsavedChanges])
  useEffect(() => {
    if (mode !== 'editor') heading.current?.focus()
    else if (!busy && editorFocusPending.current) {
      editorFocusPending.current = false
      analysisInput.current?.focus()
    }
  }, [mode, busy, note])

  const escapeClose = useRef<(() => void) | undefined>(undefined)
  const requestLeave = (action: () => void): void => {
    if (busy) return
    if (hasUnsavedChanges) {
      leaveInitiator.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setLeave(() => action)
    } else action()
  }
  useLayoutEffect(() => {
    // Radix's native Escape listener can retain the first render's callback. Keep the current
    // owner guard available to that listener as busy and dirty state change.
    escapeClose.current = () => {
      if (!busy && !preview && !leave && !pendingDelete) requestLeave(onClose)
    }
  })
  const operation = async (
    action: () => Promise<void>,
    failure: string,
    again: (() => void) | undefined
  ): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setRetry(() => again)
    try {
      await action()
    } catch {
      if (alive.current) setError(failure)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const loadNotes = async (): Promise<void> => {
    const result = await api.literature.synthesis({ action: 'list' })
    if (result.action !== 'list') throw new Error('Unexpected synthesis response.')
    if (alive.current) setNotes(result.notes)
  }
  const refresh = (): void => {
    void operation(loadNotes, t('Synthesis notes could not be loaded.'), refresh)
  }
  const updateNoteSummary = (next: SynthesisNote): void => {
    const summary = synthesisNoteSummary(next)
    setNotes((current) => {
      const updated = [...current]
      const index = updated.findIndex((entry) => entry.id === next.id)
      if (index < 0) updated.push(summary)
      else updated[index] = summary
      return updated.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    })
  }
  const acceptNote = (next: SynthesisNote, focusEditor = true): void => {
    setRemovedBlock(undefined)
    editorFocusPending.current = focusEditor
    const draft =
      overallAnalysisBlock(next.blocks) || next.blocks.length >= 200
        ? next
        : {
            ...next,
            blocks: [{ type: 'text' as const, id: crypto.randomUUID(), text: '' }, ...next.blocks]
          }
    setTransientEmptyBlocks(new Set(draft === next ? [] : [draft.blocks[0]!.id]))
    setNote(draft)
    setSaved(next)
    setMode('editor')
    setCandidateState(undefined)
    setError(undefined)
    updateNoteSummary(next)
  }
  const openNote = (noteId: string): void => {
    void operation(
      async () => {
        const result = await api.literature.synthesis({ action: 'read', noteId })
        if (result.action !== 'read') throw new Error('Unexpected synthesis response.')
        if (alive.current) acceptNote(result.note)
      },
      t('Synthesis note could not be loaded.'),
      () => openNote(noteId)
    )
  }
  const readCandidates = async (ids: string[]): Promise<CandidateState> => {
    const itemIds = [...new Set(ids)]
    if (itemIds.length === 0 || itemIds.length > 50) throw new Error('Invalid synthesis selection.')
    const candidates = await readSynthesisCandidates(
      (request) => api.literature.synthesis(request),
      itemIds
    )
    const titles: Record<string, string> = {}
    for (const candidate of candidates) titles[candidate.itemId] = candidate.bibliography.title
    await Promise.all(
      itemIds
        .filter((id) => !titles[id])
        .map(async (id) => {
          // Membership/availability has already been validated by the candidate endpoint.
          const item = await api.literature.get(id)
          if (item) titles[id] = item.item.title
        })
    )
    return { itemIds, candidates, titles }
  }
  const requireSavedDraft = (): boolean => {
    if (!dirtyRef.current) return true
    setError(t('Unsaved changes. Save before appending or exporting.'))
    setRetry(undefined)
    return false
  }
  const beginCandidates = (append = false): void => {
    if (!requireSavedDraft()) return
    void operation(
      async () => {
        const currentNote = noteRef.current
        const selected = await resolveSelectedItemIds()
        let ids = [...new Set(selected)]
        if (append && currentNote && !ids.length) {
          const sources = currentNote.blocks.flatMap((block) =>
            block.type === 'excerpt' ? [block.snapshot.itemId] : []
          )
          ids = [...new Set(sources)].slice(0, 50)
        }
        if (ids.length === 0 || ids.length > 50) {
          setRetry(undefined)
          setError(t('Select between 1 and 50 references to choose excerpts.'))
          return
        }
        const state = await readCandidates(ids)
        if (alive.current) {
          setCandidateState(state)
          setAppendTarget(append && currentNote ? currentNote.id : '')
          setRemovedBlock(undefined)
          setMode('candidates')
        }
      },
      t('Annotations could not be loaded. Your reference selection is kept.'),
      () => beginCandidates(append)
    )
  }
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (createFromSelection) {
      void loadNotes()
        .then(() => {
          if (alive.current) beginCandidates()
        })
        .catch(() => {
          if (alive.current) {
            setError(t('Synthesis notes could not be loaded.'))
            setRetry(() => refresh)
            setBusy(false)
          }
        })
    } else refresh()
    // Initial entry intent is captured once; selection itself is resolved by the owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recoverSave = async (noteId: string, requestId?: string): Promise<boolean> => {
    const result = await api.literature.synthesis({ action: 'read', noteId })
    if (result.action !== 'read') throw new Error('Unexpected synthesis response.')
    const draft = noteRef.current
    if (!draft || draft.id !== noteId) throw new Error('The edited note changed.')
    const receiptId = result.note.lastMutation?.id
    const known = receiptId ? unconfirmedSaves.current.get(receiptId) : undefined
    if (known?.noteId === noteId) {
      const recovered: SynthesisNote = {
        ...result.note,
        title: draft.title,
        blocks: draft.blocks.map((block) =>
          block.type === 'excerpt'
            ? (result.note.blocks.find((stored) => stored.id === block.id) ?? block)
            : block
        )
      }
      noteRef.current = recovered
      setNote(recovered)
      setSaved(result.note)
      updateNoteSummary(result.note)
      for (const [id, pending] of unconfirmedSaves.current) {
        if (pending.noteId === noteId && pending.expectedRevision < result.note.revision)
          unconfirmedSaves.current.delete(id)
      }
      identifyMutation.forget(receiptId!)
      if (receiptId === requestId) setRemovedBlock(undefined)
      return receiptId === requestId
    }
    if (result.note.revision !== draft.revision)
      throw new Error('The stored note changed in another editor.')
    return false
  }
  const save = (): void => {
    const currentDraft = noteRef.current
    if (!currentDraft) return
    void operation(
      async () => {
        if (
          [...unconfirmedSaves.current.values()].some(
            (pending) => pending.noteId === currentDraft.id
          )
        ) {
          // Resolve an uncertain earlier write before rebasing a newly edited draft. A receipt from
          // another editor never authorizes overwriting its revision.
          await recoverSave(currentDraft.id)
        }
        const draft = noteRef.current!
        const request = identifyMutation({
          action: 'update',
          noteId: draft.id,
          expectedRevision: draft.revision,
          title: draft.title,
          blocks: editableDraftBlocks(draft.blocks)
        })
        if (request.action !== 'update') throw new Error('Unexpected synthesis mutation.')
        unconfirmedSaves.current.set(request.requestId, {
          noteId: draft.id,
          expectedRevision: draft.revision
        })
        try {
          const result = await api.literature.synthesis(request)
          if (result.action !== 'update') throw new Error('Unexpected synthesis response.')
          unconfirmedSaves.current.delete(request.requestId)
          identifyMutation.forget(request.requestId)
          if (alive.current) {
            acceptNote(result.note, false)
          }
        } catch (failure) {
          try {
            if (await recoverSave(draft.id, request.requestId)) {
              return
            }
          } catch {
            /* The uncertain write and editable draft remain available for a later retry. */
          }
          throw failure
        }
      },
      t(
        'The note could not be saved. Your changes are kept. Retry, or copy your text before closing.'
      ),
      save
    )
  }
  const useCandidates = (title: string, candidates: SynthesisCandidate[]): void => {
    if (!candidateState) return
    void operation(
      async () => {
        const excerpts = candidates.map(({ itemId, versionId, annotationId, annotation }) => ({
          itemId,
          versionId,
          annotationId,
          expectedUpdatedAt: annotation.updatedAt
        }))
        let result
        if (appendTarget) {
          const intentKey = JSON.stringify({
            noteId: appendTarget,
            itemIds: candidateState.itemIds,
            excerpts
          })
          let pending = pendingAppends.current.get(intentKey)
          if (!pending) {
            const current = await api.literature.synthesis({
              action: 'revision',
              noteId: appendTarget
            })
            if (current.action !== 'revision') throw new Error('Unexpected synthesis response.')
            pending = identifyMutation({
              action: 'append',
              noteId: current.noteId,
              expectedRevision: current.revision,
              itemIds: candidateState.itemIds,
              excerpts
            })
            pendingAppends.current.set(intentKey, pending)
          }
          if (pending.action !== 'append') throw new Error('Unexpected synthesis mutation.')
          try {
            result = await api.literature.synthesis(pending)
          } catch (failure) {
            let recovered: SynthesisNote | undefined
            try {
              const current = await api.literature.synthesis({
                action: 'read',
                noteId: pending.noteId
              })
              if (current.action !== 'read') throw new Error('Unexpected synthesis response.')
              if (
                current.note.lastMutation?.id === pending.requestId ||
                current.note.lastNoopAppend?.id === pending.requestId
              )
                recovered = current.note
              else if (current.note.revision !== pending.expectedRevision) {
                // Keep the selection, but let the next explicit confirmation append to the new
                // baseline. An uncertain write on the same revision retains its original identity.
                pendingAppends.current.delete(intentKey)
                identifyMutation.forget(pending.requestId)
              }
            } catch {
              /* A failed recovery read leaves the original request available for exact replay. */
            }
            if (!recovered) throw failure
            result = { action: 'append', note: recovered }
          }
          pendingAppends.current.delete(intentKey)
          identifyMutation.forget(pending.requestId)
          if (result.action === 'append-rejected') {
            setError(t('This note has reached the 200-block limit.'))
            setRetry(undefined)
            return
          }
        } else {
          const request = identifyMutation({
            action: 'create',
            title,
            itemIds: candidateState.itemIds,
            excerpts
          })
          result = await api.literature.synthesis(request)
          if (result.action === 'create') identifyMutation.forget(request.requestId)
        }
        if (result.action !== 'create' && result.action !== 'append')
          throw new Error('Unexpected synthesis response.')
        if (alive.current) acceptNote(result.note)
      },
      t('The excerpts could not be saved. Your selection is kept.'),
      undefined
    )
  }
  const exportNote = (): void => {
    if (!requireSavedDraft()) return
    const currentNote = noteRef.current
    if (!currentNote) return
    void operation(
      async () => {
        const result = await api.literature.synthesis({
          action: 'export',
          noteId: currentNote.id,
          expectedRevision: currentNote.revision
        })
        if (result.action !== 'export') throw new Error('Unexpected synthesis response.')
        await api.saveBlobFile({
          suggestedName: result.filename,
          mimeType: 'text/markdown',
          data: new TextEncoder().encode(result.markdown).buffer as ArrayBuffer
        })
      },
      t('The note could not be exported.'),
      exportNote
    )
  }
  const showSource = (
    block: Extract<SynthesisBlock, { type: 'excerpt' }>,
    initiator: HTMLButtonElement
  ): void => {
    if (!note) return
    const noteId = note.id
    previewInitiator.current = initiator
    previewInitiatorBlockId.current = block.id
    void operation(
      async () => {
        const result = await api.literature.synthesis({
          action: 'source',
          noteId,
          blockId: block.id
        })
        if (result.action !== 'source') throw new Error('Unexpected synthesis response.')
        if (!alive.current || noteRef.current?.id !== noteId) return
        const source = result.block
        const updateSourceStatus = (value: SynthesisNote | undefined): SynthesisNote | undefined =>
          value?.id === noteId
            ? {
                ...value,
                blocks: value.blocks.map((entry) =>
                  entry.id === block.id && entry.type === 'excerpt'
                    ? { ...entry, sourceStatus: source.sourceStatus }
                    : entry
                )
              }
            : value
        setNote(updateSourceStatus)
        setSaved(updateSourceStatus)
        if (source.sourceStatus === 'unavailable') {
          setRetry(undefined)
          setError(t('The source PDF or annotation is unavailable. The saved excerpt is kept.'))
          return
        }
        const item = createBookmarkPreviewItem({
          id: source.snapshot.annotation.id,
          kind: 'pdf',
          ...source.snapshot.annotation.target
        })
        if (!item) {
          setError(t('The source PDF or annotation is unavailable. The saved excerpt is kept.'))
          setRetry(undefined)
          return
        }
        if (alive.current) {
          setPreview({ candidate: source.snapshot, item })
        }
      },
      t('The source PDF could not be opened.'),
      () => showSource(block, initiator)
    )
  }
  const showCandidateSource = (
    candidate: SynthesisCandidate,
    initiator: HTMLButtonElement
  ): void => {
    previewInitiator.current = initiator
    previewInitiatorBlockId.current = undefined
    const item = createBookmarkPreviewItem({
      id: candidate.annotation.id,
      kind: 'pdf',
      ...candidate.annotation.target
    })
    if (!item) {
      setError(t('PDF annotations are unavailable for this source.'))
      return
    }
    setError(undefined)
    setPreview({ candidate, item })
  }
  const onPreviewError = useCallback(
    (message: string) => {
      setError(message)
      setPreview(undefined)
      restorePreviewFocus()
    },
    [restorePreviewFocus, setError, setPreview]
  )
  const editBlock = (id: string, text: string): void =>
    setNote((current) => {
      if (!current) return current
      const blocks = current.blocks.map((block) =>
        block.id === id && block.type !== 'excerpt' ? { ...block, text } : block
      )
      return draftBlockCount(blocks) > 200 ? current : { ...current, blocks }
    })
  const undoRemoveBlock = (): void => {
    const current = noteRef.current
    if (
      busy ||
      !current ||
      !removedBlock ||
      current.id !== removedBlock.noteId ||
      draftBlockCount([...current.blocks, removedBlock.block]) > 200 ||
      current.blocks.some((block) => block.id === removedBlock.block.id)
    )
      return
    const nextIndex = current.blocks.findIndex((block) => block.id === removedBlock.nextId)
    const previousIndex = current.blocks.findIndex((block) => block.id === removedBlock.previousId)
    const index =
      nextIndex >= 0
        ? nextIndex
        : previousIndex >= 0
          ? previousIndex + 1
          : Math.min(removedBlock.index, current.blocks.length)
    setNote({
      ...current,
      blocks: [
        ...current.blocks.slice(0, index),
        removedBlock.block,
        ...current.blocks.slice(index)
      ]
    })
    setRemovedBlock(undefined)
    requestAnimationFrame(() => {
      const element = blockElements.current.get(removedBlock.block.id)
      ;(element?.querySelector<HTMLElement>('input, textarea') ?? element)?.focus()
    })
  }
  const addedBlockFocusPending = useRef<string | undefined>(undefined)
  const focusAddedBlock = (event?: Event): void => {
    const id = addedBlockFocusPending.current
    if (!id) return
    addedBlockFocusPending.current = undefined
    event?.preventDefault()
    requestAnimationFrame(() =>
      blockElements.current.get(id)?.querySelector<HTMLElement>('input, textarea')?.focus()
    )
  }
  const addBlock = (type: 'heading' | 'text', afterId?: string): void => {
    const current = noteRef.current
    if (!current || draftBlockCount(current.blocks) >= 200) return
    let index = current.blocks.length
    if (afterId !== undefined) {
      const excerptIndex = current.blocks.findIndex(
        (block) => block.id === afterId && block.type === 'excerpt'
      )
      if (excerptIndex < 0) return
      index = excerptIndex + 1
      while (current.blocks[index]?.type === 'text') index++
    }
    const existing = current.blocks[index - 1]
    if (existing?.type === type && !existing.text.trim()) {
      addedBlockFocusPending.current = existing.id
      return
    }
    const id = crypto.randomUUID()
    addedBlockFocusPending.current = id
    setTransientEmptyBlocks((previous) => new Set([...previous, id]))
    setNote({
      ...current,
      blocks: [
        ...current.blocks.slice(0, index),
        type === 'heading' ? { type, id, text: '', level: 2 } : { type, id, text: '' },
        ...current.blocks.slice(index)
      ]
    })
  }
  const addReference = (id: string): void => {
    if (!candidateState || candidateState.itemIds.includes(id)) return
    if (candidateState.itemIds.length >= 50) {
      setError(t('Select between 1 and 50 references to choose excerpts.'))
      setRetry(undefined)
      return
    }
    void operation(
      async () => {
        const addition = await readCandidates([id])
        if (alive.current)
          setCandidateState((current) =>
            current
              ? {
                  itemIds: [...current.itemIds, id],
                  candidates: [
                    ...current.candidates,
                    ...addition.candidates.filter(
                      (candidate) =>
                        !current.candidates.some(
                          (existing) => existing.annotationId === candidate.annotationId
                        )
                    )
                  ],
                  titles: { ...current.titles, ...addition.titles }
                }
              : current
          )
      },
      t('Annotations could not be loaded. Your reference selection is kept.'),
      () => addReference(id)
    )
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !preview) requestLeave(onClose)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-describedby={undefined}
          className={dialogPanelClassName(
            'top-[var(--windows-content-center-y)] flex max-h-[calc(100dvh-4rem)] max-w-none -translate-y-1/2 flex-col overflow-hidden p-0 max-[640px]:top-4 max-[640px]:translate-y-0',
            mode === 'editor'
              ? 'w-[min(840px,calc(100vw-2rem))]'
              : 'w-[min(960px,calc(100vw-2rem))]',
            mode !== 'candidates' &&
              'h-[min(720px,calc(100dvh-4rem))] max-[640px]:h-[min(800px,calc(100dvh-4rem))]'
          )}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (blockDrag.current) {
              clearBlockDrag()
              return
            }
            escapeClose.current?.()
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title
              ref={heading}
              tabIndex={-1}
              className={mode === 'editor' ? 'sr-only' : dialogTitleClassName}
            >
              {mode === 'candidates' ? t('Choose excerpts.') : t('Synthesis notes')}
            </Dialog.Title>
            {mode === 'editor' && note ? (
              <>
                {' '}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    requestLeave(() => {
                      setNote(undefined)
                      setSaved(undefined)
                      setRemovedBlock(undefined)
                      setMode('list')
                      setError(undefined)
                    })
                  }
                >
                  <ArrowLeft aria-hidden="true" />
                  {t('Back to synthesis notes')}
                </Button>
                <Input
                  aria-label={t('Note title')}
                  value={note.title}
                  maxLength={300}
                  disabled={busy}
                  className="min-w-0 flex-1 border-transparent bg-transparent px-0 text-lg font-semibold shadow-none hover:border-input focus-visible:px-3"
                  onChange={(event) => setNote({ ...note, title: event.target.value })}
                />
              </>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className={dialogCloseButtonClassName}
              aria-label={t('Close')}
              disabled={busy}
              onClick={() => requestLeave(onClose)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {mode === 'editor' && note ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2">
              <Button size="sm" disabled={busy || !dirty || !note.title.trim()} onClick={save}>
                {t('Save')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || dirty}
                onClick={() => beginCandidates(true)}
              >
                {t('Append excerpts')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('More actions')}
                    disabled={busy}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={focusAddedBlock}>
                  <DropdownMenuItem
                    disabled={blockLimitReached}
                    onSelect={() => addBlock('heading')}
                  >
                    {t('Add heading')}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={blockLimitReached} onSelect={() => addBlock('text')}>
                    {t('Add paragraph')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={dirty} onSelect={exportNote}>
                    {t('Export Markdown')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span role="status" className="ml-auto text-xs text-muted-foreground">
                {dirty ? t('Unsaved changes') : t('Saved')}
              </span>
            </div>
          ) : null}
          {mode === 'editor' && note && removedBlock?.noteId === note.id ? (
            <div ref={undoNotice} className="shrink-0 border-b border-border/60 px-5 py-2">
              <ErrorNotice
                inline
                level="info"
                role="status"
                title={t('Block removed.')}
                primaryButton={{
                  label: t('Undo'),
                  variant: 'ghost',
                  onClick: undoRemoveBlock,
                  disabled: busy || draftBlockCount([...note.blocks, removedBlock.block]) > 200
                }}
              />
            </div>
          ) : null}
          <div
            className={`${dialogBodyClassName} min-h-0 ${mode === 'candidates' ? 'overflow-y-auto max-[640px]:flex max-[640px]:flex-1 max-[640px]:flex-col max-[640px]:overflow-hidden' : 'flex-1 overflow-y-auto'}`}
            aria-busy={busy}
          >
            {error ? (
              <div className="mb-4">
                <ErrorNotice
                  title={error}
                  primaryButton={
                    retry ? { label: t('Retry'), onClick: retry, disabled: busy } : undefined
                  }
                />
              </div>
            ) : null}
            {busy ? (
              <p role="status" className="mb-3 text-sm text-muted-foreground">
                {t('Loading')}
              </p>
            ) : null}
            {mode === 'list' ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t('Arrange excerpts from several references with your own headings and text.')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => beginCandidates()}>
                    {t('Create from selected references')}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={refresh}>
                    {t('Refresh')}
                  </Button>
                </div>
                <label className="block space-y-1 text-sm">
                  <span>{t('Search synthesis notes')}</span>
                  <Input
                    type="search"
                    placeholder={t('Search by title, author, or tag')}
                    value={notesQuery}
                    disabled={busy}
                    onChange={(event) => setNotesQuery(event.target.value)}
                  />
                </label>
                {!notes.length && !busy ? (
                  <p className="py-8 text-sm text-muted-foreground">
                    {t('No synthesis notes yet. Select references in the library to get started.')}
                  </p>
                ) : null}
                {notes.length > 0 && shownNotes.length === 0 && !busy ? (
                  <p role="status" className="py-8 text-sm text-muted-foreground">
                    {t('No synthesis notes match this search.')}
                  </p>
                ) : null}
                <ul className="divide-y divide-border">
                  {shownNotes.map(({ entry, matchingMetadata }) => {
                    const snippet = notesKeyword
                      ? noteSearchSnippet(entry, notesKeyword)
                      : undefined
                    return (
                      <li key={entry.id} className="flex items-center gap-3 py-3">
                        <div className="min-w-0 flex-1">
                          <button
                            className="block w-full truncate text-left text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={busy}
                            onClick={() => openNote(entry.id)}
                          >
                            {entry.title}
                          </button>
                          {matchingMetadata.length ? (
                            <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                              {matchingMetadata.map((source) => (
                                <div key={source.title} className="space-y-0.5">
                                  <p className="break-words">
                                    <span className="font-medium text-foreground">
                                      {t('Reference')}
                                    </span>
                                    {source.title}
                                  </p>
                                  {source.authors ? (
                                    <p className="break-words">
                                      <span className="font-medium text-foreground">
                                        {t('Authors')}
                                      </span>
                                      {source.authors}
                                    </p>
                                  ) : null}
                                  {source.tags.length ? (
                                    <p className="break-words">
                                      {t('Tags: {{tags}}', { tags: source.tags.join(', ') })}
                                    </p>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {snippet ? (
                            <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                              {snippet}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={t('Delete note: {{title}}', { title: entry.title })}
                          onClick={() => setPendingDelete(entry)}
                        >
                          {t('Delete')}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
            {mode === 'candidates' && candidateState ? (
              <div className="min-w-0 max-[640px]:flex max-[640px]:min-h-0 max-[640px]:flex-1 max-[640px]:flex-col max-[640px]:overflow-hidden">
                <SynthesisCandidates
                  itemIds={candidateState.itemIds}
                  candidates={candidateState.candidates}
                  titles={candidateState.titles}
                  busy={busy}
                  append={Boolean(appendTarget)}
                  onOpenSource={showCandidateSource}
                  onDraftChange={setCandidateDirty}
                  secondary={
                    <details className="rounded-md border border-border/70 bg-background/40 p-2">
                      <summary className="cursor-pointer list-none text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                        {t('Add reference')}
                      </summary>
                      <div className="mt-3">
                        <SynthesisReferenceSearch
                          itemIds={candidateState.itemIds}
                          disabled={busy}
                          onAdd={addReference}
                        />
                      </div>
                    </details>
                  }
                  onCancel={() => {
                    requestLeave(() => {
                      setMode(note ? 'editor' : 'list')
                      setCandidateState(undefined)
                      setError(undefined)
                    })
                  }}
                  onConfirm={useCandidates}
                />
              </div>
            ) : null}
            {mode === 'editor' && note ? (
              <div className="space-y-4">
                {blockLimitReached ? (
                  <p className="text-sm text-muted-foreground">
                    {t('This note has reached the 200-block limit.')}
                  </p>
                ) : null}
                <ol
                  className="space-y-3"
                  data-synthesis-block-list
                  onDragEnter={previewBlockDrop}
                  onDragOver={previewBlockDrop}
                  onDragLeave={(event) => {
                    if (
                      !(event.relatedTarget instanceof Node) ||
                      !event.currentTarget.contains(event.relatedTarget)
                    )
                      setDropBoundary(undefined)
                  }}
                  onDrop={(event) => {
                    const drag = blockDrag.current
                    if (
                      !busy &&
                      drag?.noteId === note.id &&
                      event.dataTransfer.getData(blockDragType) === drag.blockId &&
                      dropBoundary !== undefined
                    ) {
                      event.preventDefault()
                      setNote((current) =>
                        current?.id === drag.noteId
                          ? {
                              ...current,
                              blocks: insertSynthesisBlock(
                                current.blocks,
                                drag.blockId,
                                dropBoundary
                              )
                            }
                          : current
                      )
                    }
                    clearBlockDrag()
                  }}
                >
                  {note.blocks.map((block, index) => (
                    <li
                      key={block.id}
                      data-synthesis-block={block.id}
                      tabIndex={-1}
                      ref={(element) => {
                        if (element) blockElements.current.set(block.id, element)
                        else blockElements.current.delete(block.id)
                      }}
                      aria-label={t('Block {{position}} of {{total}}', {
                        position: index + 1,
                        total: note.blocks.length
                      })}
                      className={`relative min-w-0 rounded-lg focus-visible:keyboard-focus ${draggedBlockId === block.id ? 'opacity-50' : ''} ${
                        block.type === 'excerpt'
                          ? 'group/excerpt border border-border bg-muted/10 p-4'
                          : block.type === 'text'
                            ? 'border border-input bg-card px-4 py-2 has-[textarea:focus]:border-ring has-[textarea:focus]:ring-2 has-[textarea:focus]:ring-inset has-[textarea:focus]:ring-ring/50'
                            : ''
                      }`}
                    >
                      {dropBoundary === index ||
                      (dropBoundary === note.blocks.length && index === note.blocks.length - 1) ? (
                        <span
                          aria-hidden="true"
                          data-synthesis-drop-indicator
                          className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary ${dropBoundary === index ? '-top-2' : '-bottom-2'}`}
                        />
                      ) : null}
                      <div
                        className={`flex gap-1 max-[640px]:gap-3 ${block.type === 'excerpt' ? 'mb-3 items-start' : block.type === 'text' ? 'mb-1.5 items-center' : 'absolute top-2 right-2'}`}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 cursor-grab active:cursor-grabbing max-[640px]:hidden"
                          aria-label={t('Drag to reorder')}
                          title={t('Drag to reorder')}
                          data-synthesis-drag-handle={block.id}
                          disabled={busy || note.blocks.length < 2}
                          draggable={!busy && note.blocks.length > 1}
                          onDragStart={(event) => {
                            blockDrag.current = { noteId: note.id, blockId: block.id }
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData(blockDragType, block.id)
                            const element = blockElements.current.get(block.id)
                            if (element) {
                              const rect = element.getBoundingClientRect()
                              event.dataTransfer.setDragImage(
                                element,
                                event.clientX - rect.left,
                                event.clientY - rect.top
                              )
                            }
                            setDraggedBlockId(block.id)
                            setDropBoundary(undefined)
                          }}
                          onDragEnd={clearBlockDrag}
                        >
                          <GripVertical className="size-4" aria-hidden="true" />
                        </Button>
                        {block.type === 'excerpt' ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto min-w-0 flex-1 justify-start gap-1.5 whitespace-normal p-0 text-left"
                            aria-describedby={`synthesis-source-action-${block.id}`}
                            title={t('Open source')}
                            data-synthesis-source-block={block.id}
                            disabled={busy}
                            onClick={(event) => showSource(block, event.currentTarget)}
                          >
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                              <span className="font-medium">
                                {block.snapshot.bibliography.title}
                              </span>
                              <span className="ml-1.5 inline-block whitespace-nowrap text-muted-foreground">
                                ·{' '}
                                {'pageNumber' in block.snapshot.annotation.target.selector
                                  ? t('Page {{page}}', {
                                      page: block.snapshot.annotation.target.selector.pageNumber
                                    })
                                  : t('Document')}
                              </span>
                            </span>
                          </Button>
                        ) : null}
                        {block.type === 'text' && (
                          <label
                            htmlFor={`analysis-${block.id}`}
                            className="min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                          >
                            {note.blocks.slice(0, index).findLast((entry) => entry.type !== 'text')
                              ?.type === 'excerpt'
                              ? t('Excerpt analysis')
                              : t('Overall analysis')}
                          </label>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('Block actions')}
                              disabled={busy}
                              className="shrink-0"
                            >
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            onCloseAutoFocus={(event) => {
                              focusAddedBlock(event)
                              if (blockFocusPending.current) {
                                event.preventDefault()
                                const blockId = blockFocusPending.current
                                blockFocusPending.current = undefined
                                requestAnimationFrame(() => {
                                  const target =
                                    blockElements.current.get(blockId) ??
                                    undoNotice.current?.querySelector<HTMLElement>('button')
                                  target?.focus()
                                })
                              }
                            }}
                          >
                            {block.type === 'excerpt' && (
                              <DropdownMenuItem
                                disabled={blockLimitReached}
                                onSelect={() => addBlock('text', block.id)}
                              >
                                {t('Write analysis below')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              disabled={index === 0}
                              onSelect={() => {
                                blockFocusPending.current = block.id
                                setNote({
                                  ...note,
                                  blocks: moveSynthesisBlock(note.blocks, block.id, -1)
                                })
                              }}
                            >
                              {t('Move up')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={index === note.blocks.length - 1}
                              onSelect={() => {
                                blockFocusPending.current = block.id
                                setNote({
                                  ...note,
                                  blocks: moveSynthesisBlock(note.blocks, block.id, 1)
                                })
                              }}
                            >
                              {t('Move down')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                blockFocusPending.current =
                                  note.blocks[index + 1]?.id ??
                                  note.blocks[index - 1]?.id ??
                                  block.id
                                setRemovedBlock({
                                  noteId: note.id,
                                  block,
                                  index,
                                  previousId: note.blocks[index - 1]?.id,
                                  nextId: note.blocks[index + 1]?.id
                                })
                                setNote({
                                  ...note,
                                  blocks: note.blocks.filter((entry) => entry.id !== block.id)
                                })
                              }}
                            >
                              {t('Remove')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {block.type === 'heading' ? (
                        <Input
                          aria-label={t('Heading')}
                          className="h-12 pr-20 font-medium max-[640px]:pr-12"
                          value={block.text}
                          maxLength={2000}
                          disabled={busy || (blockLimitReached && isTransientEmptyBlock(block))}
                          onChange={(event) => editBlock(block.id, event.target.value)}
                        />
                      ) : block.type === 'text' ? (
                        <Textarea
                          id={`analysis-${block.id}`}
                          ref={block.id === analysisBlockId ? analysisInput : undefined}
                          value={block.text}
                          maxLength={20000}
                          disabled={busy || (blockLimitReached && isTransientEmptyBlock(block))}
                          onChange={(event) => editBlock(block.id, event.target.value)}
                          className="min-h-[calc(4lh+1rem)] rounded-none border-0 px-0 text-[15px] leading-relaxed focus-visible:ring-0 dark:bg-transparent"
                        />
                      ) : (
                        <div className="space-y-2 text-sm">
                          {renderExcerptQuote(block.snapshot)}
                          {block.snapshot.annotation.note ? (
                            <p className="whitespace-pre-wrap">{block.snapshot.annotation.note}</p>
                          ) : null}
                          <div className="flex flex-wrap gap-1">
                            {block.snapshot.tags.map((tag) => (
                              <span key={tag.id} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                                {tag.name}
                              </span>
                            ))}
                          </div>
                          <span id={`synthesis-source-action-${block.id}`} className="sr-only">
                            {t('Open source')}
                          </span>
                          <div className="flex flex-wrap items-center justify-between gap-x-2">
                            {' '}
                            <p className="text-xs text-muted-foreground">
                              {block.snapshot.bibliography.authors}
                              {block.snapshot.bibliography.year
                                ? ` (${block.snapshot.bibliography.year})`
                                : ''}
                            </p>
                            <Button
                              variant="ghost"
                              size="xs"
                              className="invisible text-primary group-hover/excerpt:visible group-focus-within/excerpt:visible max-[640px]:hidden"
                              disabled={busy || blockLimitReached}
                              onClick={() => {
                                addBlock('text', block.id)
                                focusAddedBlock()
                              }}
                            >
                              {t('Write analysis below')}
                            </Button>
                          </div>
                          {block.sourceStatus !== 'current' ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span
                                className={`rounded-full px-2 py-0.5 font-medium ${
                                  block.sourceStatus === 'changed'
                                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {block.sourceStatus === 'changed'
                                  ? t('Changed')
                                  : block.sourceStatus === 'unverified'
                                    ? t('Unverified')
                                    : t('Unavailable')}
                              </span>
                              <span className="text-muted-foreground">
                                {block.sourceStatus === 'changed'
                                  ? t('Source changed. This excerpt remains a saved snapshot.')
                                  : block.sourceStatus === 'unverified'
                                    ? t('Source status could not be checked.')
                                    : t(
                                        'Source unavailable. This excerpt remains a saved snapshot.'
                                      )}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
          <ConfirmActionDialog
            open={Boolean(leave)}
            title={t('Discard unsaved changes?')}
            description={t('Your unsaved changes will be lost.')}
            cancelLabel={t('Keep editing')}
            confirmLabel={t('Discard changes')}
            onCloseAutoFocus={(event) => {
              if (leaveInitiator.current?.isConnected) {
                event.preventDefault()
                leaveInitiator.current.focus()
              }
              leaveInitiator.current = null
            }}
            onCancel={() => setLeave(undefined)}
            onConfirm={() => {
              const action = leave
              setLeave(undefined)
              action?.()
            }}
          />
          <ConfirmActionDialog
            open={Boolean(pendingDelete)}
            title={t('Delete synthesis note?')}
            description={t(
              'This deletes the synthesis note. Source references, annotations, and tags are kept.'
            )}
            cancelLabel={t('Cancel')}
            confirmLabel={t('Delete')}
            destructive
            loading={busy}
            onCancel={() => setPendingDelete(undefined)}
            onConfirm={() => {
              if (!pendingDelete) return
              const target = pendingDelete
              const request = identifyMutation({
                action: 'delete',
                noteId: target.id,
                expectedRevision: target.revision
              })
              void operation(
                async () => {
                  const result = await api.literature.synthesis(request)
                  if (result.action !== 'delete' || !result.deleted)
                    throw new Error('Synthesis deletion failed.')
                  identifyMutation.forget(request.requestId)
                  if (alive.current) {
                    setNotes((current) => current.filter((entry) => entry.id !== target.id))
                    setPendingDelete(undefined)
                  }
                },
                t('The note could not be deleted. Refresh notes and try again.'),
                () => {
                  setPendingDelete(undefined)
                  refresh()
                }
              )
            }}
          >
            {error ? (
              <ErrorNotice
                title={error}
                primaryButton={
                  retry ? { label: t('Refresh'), onClick: retry, disabled: busy } : undefined
                }
              />
            ) : null}
          </ConfirmActionDialog>
          {preview ? (
            <PdfAnnotationPreviewDialog
              annotation={preview.candidate.annotation}
              item={preview.item}
              onError={onPreviewError}
              onClose={() => {
                setPreview(undefined)
                restorePreviewFocus()
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
