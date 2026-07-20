// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactMentionPopup } from './ArtifactMentionPopup'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialSessionState,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'

let container: HTMLDivElement
let root: Root

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

// A project with one uploaded file and one generated output artifact.
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
  // Non-image rows never read previews, but stub the api so an accidental read never throws.
  ;(window as unknown as { api: unknown }).api = {
    uploads: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    artifacts: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    }
  }
  seedProjectFiles()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

const pressKey = (key: string): void => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('ArtifactMentionPopup', () => {
  it('renders both sections with rows and tags', () => {
    act(() => {
      root.render(<ArtifactMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    expect(options()).toHaveLength(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('User uploads')
    expect(text).toContain('Other artifacts')
    expect(text).toContain('sequence.csv')
    expect(text).toContain('report.pdf')
    // Section tags distinguish upload vs generated output.
    expect(text).toContain('upload')
    expect(text).toContain('output')
  })

  it('filters rows by a case-insensitive filename query', () => {
    act(() => {
      root.render(<ArtifactMentionPopup query="REPORT" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(document.body.textContent).toContain('report.pdf')
    expect(document.body.textContent).not.toContain('sequence.csv')
  })

  it('selects the highlighted row on Enter with the picked reference shape', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<ArtifactMentionPopup query="" onSelect={onSelect} onClose={vi.fn()} />)
    })

    // First row is the upload.
    pressKey('Enter')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'upload:up-1',
        name: 'sequence.csv',
        path: '/uploads/session-1/sequence.csv',
        source: 'upload'
      })
    )
  })

  it('selects an artifact row on click', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<ArtifactMentionPopup query="" onSelect={onSelect} onClose={vi.fn()} />)
    })

    const artifactRow = options()[1]
    act(() => artifactRow.click())
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'art-1',
        name: 'report.pdf',
        path: '/workspace/report.pdf',
        source: 'artifact'
      })
    )
  })

  it('shows an empty state when the project has no artifacts', () => {
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [] })
    act(() => {
      root.render(<ArtifactMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    expect(options()).toHaveLength(0)
    expect(document.body.textContent).toContain('No artifacts yet')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(<ArtifactMentionPopup query="" onSelect={vi.fn()} onClose={onClose} />)
    })

    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('matches a filename by fuzzy subsequence a substring would miss', () => {
    act(() => {
      root.render(<ArtifactMentionPopup query="rpt" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    // "rpt" is an ordered subsequence of "report.pdf" but not a substring, and matches no upload.
    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(rendered[0].textContent).toContain('report.pdf')
    expect(document.body.textContent).not.toContain('sequence.csv')
  })

  it('highlights the matched characters in the filename', () => {
    act(() => {
      root.render(<ArtifactMentionPopup query="report" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    const marks = Array.from(document.body.querySelectorAll('mark'))
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent?.toLowerCase()).toBe('report')
  })

  it('ranks a closer fuzzy match first within a section', () => {
    // Two outputs in the same section: a prefix match must outrank a later word-boundary match.
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        createSession({
          artifacts: [
            {
              id: 'art-late',
              kind: 'managed-file',
              path: '/workspace/final-report.pdf',
              fileUrl: 'file:///workspace/final-report.pdf',
              name: 'final-report.pdf',
              mimeType: 'application/pdf',
              size: 4096,
              mtimeMs: 1710000001000
            },
            {
              id: 'art-early',
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

    act(() => {
      root.render(<ArtifactMentionPopup query="report" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    const rendered = options()
    expect(rendered).toHaveLength(2)
    // "report.pdf" (prefix) ranks ahead of "final-report.pdf" (match after the dash).
    expect(rendered[0].textContent).not.toContain('final')
    expect(rendered[1].textContent).toContain('final-report.pdf')
  })
})
