// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The regression is about WorkspaceMessageItem's real MessageScrollerItem boundary. Avoid loading
// PDF thumbnail infrastructure that is unrelated to a text-only immutable Message snapshot.
vi.mock('./artifact-preview', () => ({ ArtifactPreview: (): null => null }))

import type { ArtifactVersionProvenance } from '../../../../shared/artifact-provenance'
import { ProvenanceMessagesTimeline } from './ArtifactProvenancePanel'

type AvailableMessages = Extract<ArtifactVersionProvenance['messages'], { state: 'available' }>

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('ProvenanceMessagesTimeline integration', () => {
  it('renders the normal Session message item inside its required MessageScroller context', async () => {
    const snapshot: AvailableMessages = {
      state: 'available',
      items: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Plot a sine curve',
          createdAt: 1
        }
      ],
      activities: [
        {
          id: 'activity-1',
          kind: 'tool',
          title: 'Notebook cell',
          activityGroupId: 'activity-group-1',
          status: 'completed',
          sortIndex: 2,
          eventIds: ['event-1'],
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      activityGroups: [
        {
          id: 'activity-group-1',
          title: 'Notebook execution',
          sortIndex: 2,
          activityIds: ['activity-1'],
          createdAt: 2,
          updatedAt: 2,
          completedAt: 2
        }
      ]
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <ProvenanceMessagesTimeline
          snapshot={snapshot}
          projectId="project-1"
          sessionId="session-1"
        />
      )
    })

    expect(container.textContent).toContain('Plot a sine curve')
    expect(container.textContent).toContain('Notebook execution')

    const transcriptRows = Array.from(
      container.querySelectorAll<HTMLElement>('[class~="pb-1"][class~="pt-5"]')
    )
    expect(transcriptRows).toHaveLength(2)
    for (const row of transcriptRows) {
      expect(row.classList.contains('px-0')).toBe(true)
      expect(row.classList.contains('md:px-0')).toBe(true)
      expect(row.classList.contains('px-4')).toBe(false)
      expect(row.classList.contains('md:px-6')).toBe(false)
    }
  })
})
