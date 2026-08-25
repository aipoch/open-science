// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerEditor } from './ComposerEditor'
import {
  domToDoc,
  emptyDoc,
  LONG_PASTE_CHARACTER_THRESHOLD,
  type ComposerDoc,
  type ComposerPastedTextNode,
  type ComposerPastedTextStage
} from './composer-doc'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'

let container: HTMLDivElement
let root: Root

// jsdom omits Range.getBoundingClientRect, which the mention hook uses to anchor the popup.
Range.prototype.getBoundingClientRect = () =>
  ({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({})
  }) as DOMRect

const seedSkills = [
  {
    id: 'lit',
    name: 'Literature',
    displayName: 'Literature',
    description: 'Find, verify, and synthesize scientific papers',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'mpnn',
    name: 'ProteinMPNN',
    displayName: 'ProteinMPNN',
    description: 'Inverse-fold a protein backbone into sequence',
    source: 'personal' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  }
]

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

// A project with one uploaded file and one generated output artifact for the `@` popup.
const seedProjectFiles = (): void => {
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: [
      createSession({
        messages: [
          createMessage({
            uploads: [
              {
                id: 'up-1',
                sessionId: 'session-1',
                name: 'safe-sequence.csv',
                originalName: 'sequence.csv',
                path: '/uploads/session-1/sequence.csv',
                mimeType: 'text/csv',
                size: 2048
              }
            ]
          })
        ],
        artifacts: [
          {
            id: 'art-1',
            kind: 'managed-file',
            path: '/workspace/report.pdf',
            fileUrl: 'file:///workspace/report.pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ]
  })
  useNavigationStore.setState({ activeProjectId: 'default' })
}

const pickerProjectFiles = [
  {
    id: 'upload:up-1',
    source: 'upload' as const,
    sourceFileId: 'up-1',
    sourceVersionId: 'up-1-v1',
    projectId: 'default',
    sessionId: 'session-1',
    name: 'sequence.csv',
    path: 'upload-version:default/session-1/up-1-v1',
    mimeType: 'text/csv',
    size: 2048,
    sortAtMs: 1710000001000
  },
  {
    id: 'art-1',
    source: 'artifact' as const,
    sourceFileId: 'art-1',
    sourceVersionId: 'art-1-v1',
    projectId: 'default',
    sessionId: 'session-1',
    name: 'report.pdf',
    path: 'artifact-version:default/session-1/art-1/art-1-v1',
    mimeType: 'application/pdf',
    size: 4096,
    sortAtMs: 1710000002000
  }
]

beforeEach(() => {
  useSettingsStore.setState({ ...createInitialSettingsState(), skills: seedSkills })
  useProjectStore.setState({
    projects: [
      {
        id: 'default',
        name: 'Current Project',
        description: '',
        agentContext: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  seedProjectFiles()
  // The artifact popup icon may read image previews; stub the api so it never throws.
  ;(window as unknown as { api: unknown }).api = {
    uploads: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    artifacts: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    projectFiles: {
      listFiles: vi.fn().mockResolvedValue({
        items: pickerProjectFiles,
        totalCount: pickerProjectFiles.length
      })
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
  usePreviewWorkbenchStore.setState({ items: [], activeItemId: undefined })
})

// Default no-op props; individual tests override the ones they assert on.
const noop = (): void => {}

type Overrides = Partial<{
  doc: ComposerDoc
  onDocChange: (doc: ComposerDoc) => void
  onSubmit: () => void
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void
  onLongTextPaste: (doc: ComposerDoc, node: ComposerPastedTextStage) => void
  onLocatePastedText: (pastedTextId: string) => void
  onUndo: () => boolean
  disabled: boolean
  isHistoryBrowsing: boolean
  historyStatus: string
  onNavigateHistory: (direction: 'previous' | 'next') => boolean
  mentionPreviewContext: { sessionId: string; projectId?: string }
  focusRequest: string | number
  restoreFocusRequest: number
  caretRequest: { key: number; position: { nodeIndex: number; offset: number } }
}>

const renderEditor = (overrides: Overrides = {}): void => {
  act(() => {
    root.render(
      <ComposerEditor
        doc={overrides.doc ?? emptyDoc}
        onDocChange={overrides.onDocChange ?? noop}
        onSubmit={overrides.onSubmit ?? noop}
        onPaste={overrides.onPaste ?? noop}
        onLongTextPaste={overrides.onLongTextPaste}
        onLocatePastedText={overrides.onLocatePastedText}
        onUndo={overrides.onUndo}
        disabled={overrides.disabled}
        placeholder="Ask anything"
        ariaLabel="Ask anything"
        isHistoryBrowsing={overrides.isHistoryBrowsing}
        historyStatus={overrides.historyStatus}
        onNavigateHistory={overrides.onNavigateHistory}
        mentionPreviewContext={overrides.mentionPreviewContext}
        focusRequest={overrides.focusRequest}
        restoreFocusRequest={overrides.restoreFocusRequest}
        caretRequest={overrides.caretRequest}
      />
    )
  })
}

const editor = (): HTMLElement =>
  document.body.querySelector<HTMLElement>('[role="textbox"]') as HTMLElement

// Set a collapsed caret at the given offset inside a node.
const setCaret = (node: Node, offset: number): void => {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const dispatchKey = (target: EventTarget, key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    )
  })
}

const flushProjectFiles = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ComposerEditor', () => {
  it('shows the placeholder when the doc is empty and hides it once there is content', () => {
    renderEditor({ doc: emptyDoc })
    // The only aria-hidden node in the editor is the placeholder overlay.
    expect(
      Array.from(document.body.querySelectorAll('[aria-hidden="true"]')).some(
        (node) => node.textContent === 'Ask anything'
      )
    ).toBe(true)

    act(() => {
      root.render(
        <ComposerEditor
          doc={{ nodes: [{ type: 'text', text: 'hi' }] }}
          onDocChange={noop}
          onSubmit={noop}
          onPaste={noop}
          placeholder="Ask anything"
          ariaLabel="Ask anything"
        />
      )
    })
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('keeps an inline placeholder and a visible caret host after a pasted-text marker', () => {
    renderEditor({ focusRequest: 'session-a' })
    const root = editor()

    renderEditor({
      doc: {
        nodes: [{ type: 'pasted-text', id: 'paste-1', text: 'payload', attachmentId: 'upload-1' }]
      },
      focusRequest: 'session-a'
    })

    expect(root.getAttribute('data-inline-placeholder')).toBe('true')
    expect(root.className).toContain('after:content-[attr(data-placeholder)]')
    expect(root.querySelector('[data-pasted-text-id="paste-1"]')?.textContent).toBe('…')
    expect(
      Array.from(document.body.querySelectorAll('[aria-hidden="true"]')).some(
        (node) => node.textContent === 'Ask anything'
      )
    ).toBe(false)
    expect(document.activeElement).toBe(root)
    expect(window.getSelection()?.anchorNode?.nodeType).toBe(Node.TEXT_NODE)
    expect(window.getSelection()?.anchorNode?.textContent).toBe('\u2060')
    expect(window.getSelection()?.anchorOffset).toBe(0)

    renderEditor({
      doc: {
        nodes: [
          { type: 'pasted-text', id: 'paste-1', text: 'payload', attachmentId: 'upload-1' },
          { type: 'text', text: ' ' }
        ]
      },
      focusRequest: 'session-a'
    })
    expect(root.getAttribute('data-inline-placeholder')).toBeNull()
    expect(root.className).not.toContain('after:content-[attr(data-placeholder)]')
  })

  it('preserves the caret after a pasted-text anchor when upload metadata changes', () => {
    const pastedText = { type: 'pasted-text' as const, id: 'paste-1', text: 'payload' }
    renderEditor({
      doc: {
        nodes: [{ type: 'text', text: 'before ' }, pastedText, { type: 'text', text: ' after' }]
      },
      focusRequest: 'session-a'
    })
    const root = editor()
    const textAfterAnchor = root.childNodes[2]
    root.focus()
    setCaret(textAfterAnchor, 0)

    renderEditor({
      doc: {
        nodes: [
          { type: 'text', text: 'before ' },
          { ...pastedText, attachmentId: 'upload-1' },
          { type: 'text', text: ' after' }
        ]
      },
      focusRequest: 'session-a'
    })

    expect(window.getSelection()?.anchorNode).toBe(root.childNodes[2])
    expect(window.getSelection()?.anchorOffset).toBe(0)
    expect(domToDoc(root).nodes[1]).toEqual({ ...pastedText, attachmentId: 'upload-1' })
  })

  it('locates the matching pasted-text attachment by pointer and keyboard', () => {
    const onLocatePastedText = vi.fn()
    renderEditor({
      doc: { nodes: [{ type: 'pasted-text', id: 'paste-1', text: 'payload' }] },
      onLocatePastedText
    })
    const marker = editor().querySelector<HTMLElement>('[data-pasted-text-id="paste-1"]')!

    act(() => marker.click())
    dispatchKey(marker, 'Enter')
    dispatchKey(marker, ' ')

    expect(onLocatePastedText).toHaveBeenNthCalledWith(1, 'paste-1')
    expect(onLocatePastedText).toHaveBeenNthCalledWith(2, 'paste-1')
    expect(onLocatePastedText).toHaveBeenNthCalledWith(3, 'paste-1')
  })

  it('refreshes an artifact chip when only its MIME type changes', () => {
    const artifact = {
      type: 'artifact' as const,
      id: 'artifact-1',
      name: 'research-paper',
      path: '/workspace/research-paper',
      source: 'artifact' as const
    }
    renderEditor({ doc: { nodes: [artifact] } })
    expect(
      editor()
        .querySelector('[data-mention-type="artifact"]')
        ?.getAttribute('data-mention-mime-type')
    ).toBeNull()

    renderEditor({
      doc: { nodes: [{ ...artifact, mimeType: 'application/pdf' }] }
    })

    expect(
      editor()
        .querySelector('[data-mention-type="artifact"]')
        ?.getAttribute('data-mention-mime-type')
    ).toBe('application/pdf')
  })

  it('emits the typed text as a doc on input', () => {
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })

    act(() => {
      editor().appendChild(document.createTextNode('hello'))
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onDocChange).toHaveBeenCalledWith({ nodes: [{ type: 'text', text: 'hello' }] })
  })

  it('submits on Enter without shift and not on Shift+Enter', () => {
    const onSubmit = vi.fn()
    renderEditor({ onSubmit })

    dispatchKey(editor(), 'Enter', { shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    dispatchKey(editor(), 'Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit while an IME composition is active', () => {
    const onSubmit = vi.fn()
    renderEditor({ onSubmit })

    act(() => {
      editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    dispatchKey(editor(), 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()

    // Ending composition restores Enter-to-submit.
    act(() => {
      editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    dispatchKey(editor(), 'Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('emits one undoable document edit for an IME composition', () => {
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })
    setCaret(editor(), 0)

    act(() => {
      editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      editor().textContent = 'n'
      editor().dispatchEvent(new Event('input', { bubbles: true }))
      editor().textContent = '你'
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onDocChange).not.toHaveBeenCalled()

    act(() => {
      editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    expect(onDocChange).toHaveBeenCalledOnce()
    expect(onDocChange).toHaveBeenCalledWith(
      { nodes: [{ type: 'text', text: '你' }] },
      { nodeIndex: 0, offset: 0 }
    )
  })

  it('enters history with ArrowUp only from a collapsed caret at the logical start', () => {
    const onNavigateHistory = vi.fn(() => true)
    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'scratch' }] },
      onNavigateHistory
    })
    const text = editor().firstChild as Text

    setCaret(text, 4)
    dispatchKey(editor(), 'ArrowUp')
    expect(onNavigateHistory).not.toHaveBeenCalled()

    setCaret(text, 0)
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true
    })
    act(() => editor().dispatchEvent(arrow))
    expect(onNavigateHistory).toHaveBeenCalledWith('previous')
    expect(arrow.defaultPrevented).toBe(true)
  })

  it('enters history from an empty editor but not from after a mention chip', () => {
    const onNavigateHistory = vi.fn(() => true)
    renderEditor({ doc: emptyDoc, onNavigateHistory })
    setCaret(editor(), 0)
    dispatchKey(editor(), 'ArrowUp')
    expect(onNavigateHistory).toHaveBeenCalledOnce()

    onNavigateHistory.mockClear()
    renderEditor({
      doc: { nodes: [{ type: 'skill', id: 'lit', name: 'Literature' }] },
      onNavigateHistory
    })
    setCaret(editor(), 1)
    dispatchKey(editor(), 'ArrowUp')
    expect(onNavigateHistory).not.toHaveBeenCalled()
  })

  it('uses both arrows while browsing, but leaves modifier arrows and selections alone', () => {
    const onNavigateHistory = vi.fn(() => true)
    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'history' }] },
      isHistoryBrowsing: true,
      onNavigateHistory
    })
    const text = editor().firstChild as Text

    setCaret(text, text.length)
    dispatchKey(editor(), 'ArrowDown')
    expect(onNavigateHistory).toHaveBeenLastCalledWith('next')

    dispatchKey(editor(), 'ArrowUp', { metaKey: true })
    expect(onNavigateHistory).toHaveBeenCalledTimes(1)

    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 2)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    dispatchKey(editor(), 'ArrowUp')
    expect(onNavigateHistory).toHaveBeenCalledTimes(1)

    setCaret(text, 0)
    dispatchKey(editor(), 'ArrowUp', { isComposing: true })
    expect(onNavigateHistory).toHaveBeenCalledTimes(1)

    act(() => {
      editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    setCaret(text, 0)
    dispatchKey(editor(), 'ArrowUp')
    expect(onNavigateHistory).toHaveBeenCalledTimes(1)
  })

  it('moves the caret to the end after applying a recalled history doc', () => {
    const onNavigateHistory = vi.fn(() => true)
    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'scratch' }] },
      onNavigateHistory
    })
    setCaret(editor().firstChild as Text, 0)
    dispatchKey(editor(), 'ArrowUp')

    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'recalled' }] },
      isHistoryBrowsing: true,
      historyStatus: 'History item 1 of 1',
      onNavigateHistory
    })

    const selection = window.getSelection()
    expect(document.activeElement).toBe(editor())
    expect(selection?.anchorNode).toBe(editor())
    expect(selection?.anchorOffset).toBe(editor().childNodes.length)
    expect(document.querySelector('[role="status"]')?.textContent).toBe('History item 1 of 1')
    expect(editor().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('focuses the end of a restored draft when requested', () => {
    renderEditor({ focusRequest: 'session-b' })
    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'restored draft' }] },
      focusRequest: 'session-b'
    })

    const selection = window.getSelection()
    expect(document.activeElement).toBe(editor())
    expect(selection?.anchorNode).toBe(editor())
    expect(selection?.anchorOffset).toBe(editor().childNodes.length)
  })

  it('forwards paste to onPaste and inserts clipboard text as plain text', () => {
    const onPaste = vi.fn()
    const onDocChange = vi.fn()
    renderEditor({ onPaste, onDocChange })

    // Place the caret inside the editor so the plain-text insertion has a target range.
    editor().appendChild(document.createTextNode(''))
    setCaret(editor().firstChild as Node, 0)

    const clipboardData = { getData: (type: string) => (type === 'text/plain' ? 'pasted' : '') }
    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown
      }
      event.clipboardData = clipboardData
      editor().dispatchEvent(event)
    })

    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(editor().textContent).toContain('pasted')
    expect(onDocChange).toHaveBeenCalledWith({ nodes: [{ type: 'text', text: 'pasted' }] })
  })

  it('replaces the active selection with a long-paste anchor at the exact document position', () => {
    const onDocChange = vi.fn()
    const onLongTextPaste = vi.fn()
    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'before SELECT after' }] },
      onDocChange,
      onLongTextPaste
    })
    const textNode = editor().firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 'before '.length)
    range.setEnd(textNode, 'before SELECT'.length)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    const payload = 'x'.repeat(LONG_PASTE_CHARACTER_THRESHOLD + 1)

    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown
      }
      event.clipboardData = {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? payload : '')
      }
      editor().dispatchEvent(event)
    })

    expect(onDocChange).not.toHaveBeenCalled()
    const [nextDoc, node] = onLongTextPaste.mock.calls[0] as [ComposerDoc, ComposerPastedTextNode]
    expect(node).toMatchObject({ type: 'pasted-text', text: payload })
    expect(nextDoc).toEqual({
      nodes: [{ type: 'text', text: 'before ' }, node, { type: 'text', text: ' after' }]
    })
    expect(editor().textContent).not.toContain(payload)
  })

  it('does not stage a long paste when the selection is outside the editor', () => {
    const onLongTextPaste = vi.fn()
    renderEditor({ onLongTextPaste })
    const outside = document.createTextNode('outside')
    document.body.appendChild(outside)
    setCaret(outside, outside.textContent?.length ?? 0)
    const payload = 'x'.repeat(LONG_PASTE_CHARACTER_THRESHOLD + 1)

    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown
      }
      event.clipboardData = {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? payload : '')
      }
      editor().dispatchEvent(event)
    })

    expect(onLongTextPaste).not.toHaveBeenCalled()
    expect(outside.textContent).toBe('outside')
    expect(editor().querySelector('[data-composer-node-type="pasted-text"]')).toBeNull()
  })

  it('does not serialize a split trailing caret marker after another long paste', () => {
    const onLongTextPaste = vi.fn()
    const firstPaste = { type: 'pasted-text' as const, id: 'paste-1', text: 'first payload' }
    renderEditor({
      doc: { nodes: [firstPaste] },
      onLongTextPaste,
      focusRequest: 'session-a'
    })
    const payload = 'x'.repeat(LONG_PASTE_CHARACTER_THRESHOLD + 1)

    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown
      }
      event.clipboardData = {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? payload : '')
      }
      editor().dispatchEvent(event)
    })

    const [nextDoc, secondPaste] = onLongTextPaste.mock.calls[0] as [
      ComposerDoc,
      ComposerPastedTextNode
    ]
    expect(nextDoc.nodes).toEqual([firstPaste, secondPaste])
    expect(nextDoc.nodes).not.toContainEqual({ type: 'text', text: '\u2060' })
  })

  it('copies pasted-text markers as fresh independent anchors when pasted in the composer', () => {
    renderEditor({
      doc: {
        nodes: [
          { type: 'text', text: 'before ' },
          { type: 'pasted-text', id: 'paste-a', text: 'alpha' },
          { type: 'text', text: ' middle ' },
          { type: 'pasted-text', id: 'paste-b', text: 'bravo' },
          { type: 'text', text: ' after' }
        ]
      }
    })
    const range = document.createRange()
    range.selectNodeContents(editor())
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    const clipboard = new Map<string, string>()
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', {
      value: { setData: (type: string, value: string) => clipboard.set(type, value) }
    })

    act(() => editor().dispatchEvent(copy))

    expect(copy.defaultPrevented).toBe(true)
    expect(clipboard.get('text/plain')).toBe('before alpha middle bravo after')
    expect(clipboard.get('application/x-open-science-composer-fragment')).not.toContain('paste-a')

    const onLongTextPaste = vi.fn()
    renderEditor({ onLongTextPaste })
    setCaret(editor(), 0)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) => clipboard.get(type) ?? ''
      }
    })
    act(() => editor().dispatchEvent(paste))

    const [nextDoc, staged] = onLongTextPaste.mock.calls[0] as [
      ComposerDoc,
      ComposerPastedTextNode[]
    ]
    expect(staged).toHaveLength(2)
    expect(staged.map((node) => node.id)).not.toContain('paste-a')
    expect(staged.map((node) => node.id)).not.toContain('paste-b')
    expect(staged.map((node) => node.text)).toEqual(['alpha', 'bravo'])
    expect(nextDoc.nodes).toEqual([
      { type: 'text', text: 'before ' },
      staged[0],
      { type: 'text', text: ' middle ' },
      staged[1],
      { type: 'text', text: ' after' }
    ])
    expect(editor().textContent).not.toContain('alpha')
    expect(editor().textContent).not.toContain('bravo')
  })

  it('cuts a focused pasted-text marker with its full payload', () => {
    const onDocChange = vi.fn()
    renderEditor({
      doc: {
        nodes: [
          { type: 'text', text: 'before ' },
          { type: 'pasted-text', id: 'paste-a', text: 'full payload' },
          { type: 'text', text: ' after' }
        ]
      },
      onDocChange
    })
    const marker = editor().querySelector<HTMLElement>('[data-pasted-text-id="paste-a"]')!
    setCaret(editor(), 1)
    const clipboard = new Map<string, string>()
    const cut = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(cut, 'clipboardData', {
      value: { setData: (type: string, value: string) => clipboard.set(type, value) }
    })

    act(() => marker.dispatchEvent(cut))

    expect(cut.defaultPrevented).toBe(true)
    expect(clipboard.get('text/plain')).toBe('full payload')
    expect(clipboard.get('application/x-open-science-composer-fragment')).toContain('full payload')
    expect(onDocChange).toHaveBeenCalledWith({ nodes: [{ type: 'text', text: 'before  after' }] })
  })

  it('routes Cmd+Z only through Composer undo, including after its history is empty', () => {
    const onUndo = vi.fn(() => true)
    renderEditor({ onUndo })
    const handled = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => editor().dispatchEvent(handled))
    expect(handled.defaultPrevented).toBe(true)
    expect(onUndo).toHaveBeenCalledOnce()

    onUndo.mockReturnValue(false)
    const native = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => editor().dispatchEvent(native))
    expect(native.defaultPrevented).toBe(true)
    expect(onUndo).toHaveBeenCalledTimes(2)
  })

  it('places the caret immediately after restored pasted text', () => {
    renderEditor({
      doc: {
        nodes: [
          { type: 'text', text: 'before ' },
          { type: 'pasted-text', id: 'paste-1', text: 'payload' },
          { type: 'text', text: ' after' }
        ]
      }
    })

    renderEditor({
      doc: { nodes: [{ type: 'text', text: 'before payload after' }] },
      caretRequest: { key: 1, position: { nodeIndex: 0, offset: 'before payload'.length } }
    })

    expect(document.activeElement).toBe(editor())
    expect(window.getSelection()?.anchorNode).toBe(editor().firstChild)
    expect(window.getSelection()?.anchorOffset).toBe('before payload'.length)
  })

  it('keeps pasted "/name" text as plain text, never a functional skill chip', () => {
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })
    editor().appendChild(document.createTextNode(''))
    setCaret(editor().firstChild as Node, 0)

    const clipboardData = {
      getData: (type: string) => (type === 'text/plain' ? '/Literature' : '')
    }
    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown
      }
      event.clipboardData = clipboardData
      editor().dispatchEvent(event)
    })

    // No chip is created; the doc holds only a text node, so it carries no skill id.
    expect(editor().querySelector('[data-skill-id]')).toBeNull()
    expect(onDocChange).toHaveBeenLastCalledWith({ nodes: [{ type: 'text', text: '/Literature' }] })
  })

  it('inserts a skill chip when a suggestion is chosen from the popup', () => {
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })

    // Simulate typing "/lit": place the token in the DOM and the caret at its end, then let the
    // mention hook read the live selection via an input event.
    const textNode = document.createTextNode('/lit')
    editor().appendChild(textNode)
    setCaret(textNode, 4)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The popup opens for the query.
    const listbox = document.body.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()

    // Enter selects the first match; the editor swaps the token for a chip and re-emits the doc.
    dispatchKey(document, 'Enter')

    const chip = editor().querySelector('[data-skill-id]')
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('data-skill-id')).toBe('lit')

    const lastCall = onDocChange.mock.calls.at(-1)?.[0] as ComposerDoc
    expect(lastCall.nodes.some((node) => node.type === 'skill' && node.id === 'lit')).toBe(true)
  })

  it('exposes the active skill suggestion from the focused editor', () => {
    renderEditor()

    const textNode = document.createTextNode('/')
    editor().appendChild(textNode)
    setCaret(textNode, 1)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')
    const options = document.body.querySelectorAll<HTMLElement>('[role="option"]')
    expect(editor().getAttribute('aria-autocomplete')).toBe('list')
    expect(editor().getAttribute('aria-controls')).toBe(listbox?.id)
    expect(editor().getAttribute('aria-activedescendant')).toBe(options[0]?.id)

    dispatchKey(document, 'ArrowDown')

    expect(editor().getAttribute('aria-activedescendant')).toBe(options[1]?.id)

    dispatchKey(document, 'Escape')

    expect(editor().getAttribute('aria-autocomplete')).toBeNull()
    expect(editor().getAttribute('aria-controls')).toBeNull()
    expect(editor().getAttribute('aria-activedescendant')).toBeNull()
  })
  it('deletes the whole chip on Backspace when the caret is right after it', () => {
    const onDocChange = vi.fn()
    renderEditor({
      doc: { nodes: [{ type: 'skill', id: 'lit', name: 'Literature' }] },
      onDocChange
    })

    // Caret at editor offset 1 sits right after the chip (the editor's only child).
    setCaret(editor(), 1)
    dispatchKey(editor(), 'Backspace')

    expect(editor().querySelector('[data-skill-id]')).toBeNull()
    expect(onDocChange).toHaveBeenLastCalledWith(emptyDoc, { nodeIndex: 1, offset: 0 })
  })

  it('suppresses the popup once a skill chip exists (one skill per message)', () => {
    renderEditor({ doc: { nodes: [{ type: 'skill', id: 'lit', name: 'Literature' }] } })

    // Type "/" after the existing chip — the trigger is suppressed, so no popup opens.
    const slash = document.createTextNode('/')
    editor().appendChild(slash)
    setCaret(slash, 1)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('is not editable and never submits when disabled', () => {
    const onSubmit = vi.fn()
    renderEditor({ onSubmit, disabled: true })

    expect(editor().getAttribute('contenteditable')).toBe('false')
    expect(editor().getAttribute('aria-disabled')).toBe('true')

    dispatchKey(editor(), 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('inserts a green artifact chip when an artifact is chosen from the `@` popup', async () => {
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })

    // Type "@seq": place the token and caret at its end, then let the mention hook read the selection.
    const textNode = document.createTextNode('@seq')
    editor().appendChild(textNode)
    setCaret(textNode, 4)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flushProjectFiles()

    // The artifact popup opens and shows the matching upload.
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()

    // Enter selects the highlighted row; the editor swaps the token for a green artifact chip.
    dispatchKey(document, 'Enter')

    const chip = editor().querySelector('[data-mention-type="artifact"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('@sequence.csv')
    expect(chip?.getAttribute('data-mention-path')).toBe('upload-version:default/session-1/up-1-v1')
    expect(chip?.getAttribute('data-mention-source')).toBe('upload')
    expect(chip?.className).toContain('bg-mention-chip')

    const lastCall = onDocChange.mock.calls.at(-1)?.[0] as ComposerDoc
    expect(
      lastCall.nodes.some((node) => node.type === 'artifact' && node.id === 'upload:up-1')
    ).toBe(true)
  })

  it('inserts a Session chip from `#` and navigates by Session id when clicked', () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      selectedSessionId: 'session-1',
      sessions: [
        createSession({ id: 'session-1', title: 'Current conversation' }),
        createSession({ id: 'session-2', title: 'Prior analysis', updatedAt: 1710000001000 })
      ]
    })
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })

    const textNode = document.createTextNode('#prior')
    editor().appendChild(textNode)
    setCaret(textNode, 6)
    act(() => editor().dispatchEvent(new Event('input', { bubbles: true })))
    dispatchKey(document, 'Enter')

    const chip = editor().querySelector<HTMLElement>('[data-mention-type="session"]')
    expect(chip?.textContent).toBe('#Prior analysis')
    expect(chip?.getAttribute('data-session-id')).toBe('session-2')
    expect(chip?.getAttribute('data-project-id')).toBeNull()
    expect(chip?.getAttribute('data-frame-id')).toBeNull()
    const lastDoc = onDocChange.mock.calls.at(-1)?.[0] as ComposerDoc
    expect(lastDoc.nodes).toContainEqual({
      type: 'session',
      sessionId: 'session-2',
      title: 'Prior analysis'
    })

    act(() => chip?.click())
    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')
  })

  it('exposes the active artifact suggestion from the focused editor', async () => {
    renderEditor()

    const textNode = document.createTextNode('@')
    editor().appendChild(textNode)
    setCaret(textNode, 1)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flushProjectFiles()

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')
    const options = document.body.querySelectorAll<HTMLElement>('[role="option"]')
    expect(editor().getAttribute('aria-autocomplete')).toBe('list')
    expect(editor().getAttribute('aria-controls')).toBe(listbox?.id)
    expect(editor().getAttribute('aria-activedescendant')).toBe(options[0]?.id)

    dispatchKey(document, 'ArrowDown')

    expect(editor().getAttribute('aria-activedescendant')).toBe(options[1]?.id)
  })
  it('allows multiple artifact chips in one message', async () => {
    const onDocChange = vi.fn()
    renderEditor({
      doc: {
        nodes: [
          {
            type: 'artifact',
            id: 'up-1',
            name: 'sequence.csv',
            path: '/uploads/session-1/sequence.csv',
            source: 'upload'
          }
        ]
      },
      onDocChange
    })

    // Type "@rep" after the existing chip and select the generated artifact.
    const textNode = document.createTextNode('@rep')
    editor().appendChild(textNode)
    setCaret(textNode, 4)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flushProjectFiles()
    dispatchKey(document, 'Enter')

    const chips = editor().querySelectorAll('[data-mention-type="artifact"]')
    expect(chips).toHaveLength(2)
    expect(chips[1]?.getAttribute('data-mention-path')).toBe(
      'artifact-version:default/session-1/art-1/art-1-v1'
    )
  })

  it('suppresses the `@` popup once the artifact mention cap is reached', () => {
    const cappedNodes = Array.from({ length: 10 }, (_, index) => ({
      type: 'artifact' as const,
      id: `art-${index}`,
      name: `file-${index}.csv`,
      path: `/workspace/file-${index}.csv`,
      source: 'artifact' as const
    }))
    renderEditor({ doc: { nodes: cappedNodes } })

    // Type "@" after the ten chips — the trigger is suppressed, so no popup opens.
    const at = document.createTextNode('@')
    editor().appendChild(at)
    setCaret(at, 1)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('deletes the whole artifact chip on Backspace when the caret is right after it', () => {
    const onDocChange = vi.fn()
    renderEditor({
      doc: {
        nodes: [
          {
            type: 'artifact',
            id: 'up-1',
            name: 'sequence.csv',
            path: '/uploads/session-1/sequence.csv',
            source: 'upload'
          }
        ]
      },
      onDocChange
    })

    // Caret at editor offset 1 sits right after the chip (the editor's only child).
    setCaret(editor(), 1)
    dispatchKey(editor(), 'Backspace')

    expect(editor().querySelector('[data-mention-type="artifact"]')).toBeNull()
    expect(onDocChange).toHaveBeenLastCalledWith(emptyDoc, { nodeIndex: 1, offset: 0 })
  })

  it('opens a linked-folder chip in the preview workbench on click', () => {
    useGrantedFoldersStore.setState({
      ...createInitialGrantedFoldersState(),
      roots: [{ id: 'root-1', path: '/Users/roxi/data', name: 'data', access: 'ro' }],
      loaded: true
    })
    renderEditor({
      doc: {
        nodes: [
          {
            type: 'artifact',
            id: 'linked-1',
            name: 'study.csv',
            source: 'linked-folder',
            rootId: 'root-1',
            relativePath: 'study.csv'
          }
        ]
      }
    })

    const chip = editor().querySelector<HTMLElement>('[data-mention-source="linked-folder"]')
    act(() => chip?.click())

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'local:/Users/roxi/data/study.csv'
    )
  })

  it('keeps a linked-folder chip inert on click when its root is revoked', () => {
    renderEditor({
      doc: {
        nodes: [
          {
            type: 'artifact',
            id: 'linked-1',
            name: 'study.csv',
            source: 'linked-folder',
            rootId: 'root-1',
            relativePath: 'study.csv'
          }
        ]
      }
    })

    const chip = editor().querySelector<HTMLElement>('[data-mention-source="linked-folder"]')
    act(() => chip?.click())

    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('opens an upload mention chip in the preview workbench on click after a successful probe', async () => {
    renderEditor({
      mentionPreviewContext: { sessionId: 'session-1', projectId: 'default' },
      doc: {
        nodes: [
          {
            type: 'artifact',
            id: 'up-1',
            name: 'sequence.csv',
            path: 'upload-version:default/session-1/up-1-v1',
            source: 'upload'
          }
        ]
      }
    })

    const chip = editor().querySelector<HTMLElement>('[data-mention-source="upload"]')
    await act(async () => {
      chip?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('up-1')
  })

  it('keeps an upload mention chip inert when the probe fails', async () => {
    ;(
      window as unknown as { api: { uploads: { readPreview: ReturnType<typeof vi.fn> } } }
    ).api.uploads.readPreview.mockRejectedValueOnce(new Error('gone'))
    renderEditor({
      mentionPreviewContext: { sessionId: 'session-1', projectId: 'default' },
      doc: {
        nodes: [
          {
            type: 'artifact',
            id: 'up-1',
            name: 'sequence.csv',
            path: 'upload-version:default/session-1/up-1-v1',
            source: 'upload'
          }
        ]
      }
    })

    const chip = editor().querySelector<HTMLElement>('[data-mention-source="upload"]')
    await act(async () => {
      chip?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })
})
