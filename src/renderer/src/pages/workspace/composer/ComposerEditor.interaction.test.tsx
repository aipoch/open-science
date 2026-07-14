// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerEditor } from './ComposerEditor'
import { emptyDoc, type ComposerDoc } from './composer-doc'
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
    description: 'Find, verify, and synthesize scientific papers',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'mpnn',
    name: 'ProteinMPNN',
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

beforeEach(() => {
  useSettingsStore.setState({ ...createInitialSettingsState(), skills: seedSkills })
  seedProjectFiles()
  // The artifact popup icon may read image previews; stub the api so it never throws.
  ;(window as unknown as { api: unknown }).api = {
    uploads: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    artifacts: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
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
})

// Default no-op props; individual tests override the ones they assert on.
const noop = (): void => {}

type Overrides = Partial<{
  doc: ComposerDoc
  onDocChange: (doc: ComposerDoc) => void
  onSubmit: () => void
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void
  disabled: boolean
}>

const renderEditor = (overrides: Overrides = {}): void => {
  act(() => {
    root.render(
      <ComposerEditor
        doc={overrides.doc ?? emptyDoc}
        onDocChange={overrides.onDocChange ?? noop}
        onSubmit={overrides.onSubmit ?? noop}
        onPaste={overrides.onPaste ?? noop}
        disabled={overrides.disabled}
        placeholder="Ask anything"
        ariaLabel="Ask anything"
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

describe('ComposerEditor', () => {
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
    expect(onDocChange).toHaveBeenLastCalledWith(emptyDoc)
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

  it('inserts a green artifact chip when an artifact is chosen from the `@` popup', () => {
    const onDocChange = vi.fn()
    renderEditor({ onDocChange })

    // Type "@seq": place the token and caret at its end, then let the mention hook read the selection.
    const textNode = document.createTextNode('@seq')
    editor().appendChild(textNode)
    setCaret(textNode, 4)
    act(() => {
      editor().dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The artifact popup opens and shows the matching upload.
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()

    // Enter selects the highlighted row; the editor swaps the token for a green artifact chip.
    dispatchKey(document, 'Enter')

    const chip = editor().querySelector('[data-mention-type="artifact"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('@sequence.csv')
    expect(chip?.getAttribute('data-mention-path')).toBe('/uploads/session-1/sequence.csv')
    expect(chip?.getAttribute('data-mention-source')).toBe('upload')
    expect(chip?.className).toContain('bg-mention-chip')

    const lastCall = onDocChange.mock.calls.at(-1)?.[0] as ComposerDoc
    expect(
      lastCall.nodes.some((node) => node.type === 'artifact' && node.id === 'upload:up-1')
    ).toBe(true)
  })

  it('allows multiple artifact chips in one message', () => {
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
    dispatchKey(document, 'Enter')

    const chips = editor().querySelectorAll('[data-mention-type="artifact"]')
    expect(chips).toHaveLength(2)
    expect(chips[1]?.getAttribute('data-mention-path')).toBe('/workspace/report.pdf')
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
    expect(onDocChange).toHaveBeenLastCalledWith(emptyDoc)
  })
})
