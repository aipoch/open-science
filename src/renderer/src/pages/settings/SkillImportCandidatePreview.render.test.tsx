// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillImportCandidatePreview } from './SkillImportCandidatePreview'
import { useSkillImportCandidatePreview } from './useSkillImportCandidatePreview'

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content, allowMedia }: { content: string; allowMedia?: boolean }) => (
    <div data-testid="agent-markdown" data-allow-media={String(allowMedia)}>
      {content}
    </div>
  )
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SkillImportCandidatePreview', () => {
  it('renders read-only candidate content and closes accessibly', () => {
    const onOpenChange = vi.fn()
    act(() => {
      root.render(
        <SkillImportCandidatePreview
          open
          onOpenChange={onOpenChange}
          loading={false}
          error={null}
          content={{
            name: 'Citation helper',
            description: 'Formats citations.',
            sourceLabel: 'github.com/acme/skills/citation',
            metadata: { author: 'Ada', license: 'MIT' },
            body: '# Instructions\nUse carefully.',
            files: ['SKILL.md', 'references/style.md']
          }}
        />
      )
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Citation helper')
    expect(dialog?.textContent).toContain('Formats citations.')
    expect(dialog?.textContent).toContain('github.com/acme/skills/citation')
    expect(dialog?.textContent).toContain('# Instructions')
    expect(dialog?.textContent).toContain('references/style.md')
    expect(dialog?.textContent).toContain('Ada')
    expect(dialog?.querySelector('[role="switch"]')).toBeNull()
    expect(
      dialog?.querySelector('[data-testid="agent-markdown"]')?.getAttribute('data-allow-media')
    ).toBe('false')

    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps an in-memory preview visually stable while opening and closing', async () => {
    const content = {
      name: 'Local skill',
      description: '',
      sourceLabel: 'local.md',
      metadata: {},
      body: '# Local body',
      files: ['local.md']
    }
    const Harness = (): React.JSX.Element => {
      const preview = useSkillImportCandidatePreview()
      return (
        <>
          <button type="button" onClick={() => preview.openPreview(() => content)}>
            Open local
          </button>
          <output data-testid="preview-state">
            {JSON.stringify({
              open: preview.previewProps.open,
              loading: preview.previewProps.loading,
              body: preview.previewProps.content?.body ?? null
            })}
          </output>
          <SkillImportCandidatePreview {...preview.previewProps} />
        </>
      )
    }
    act(() => root.render(<Harness />))

    act(() => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === 'Open local')
        ?.click()
    })

    expect(document.body.querySelector('[data-testid="preview-state"]')?.textContent).toBe(
      JSON.stringify({ open: true, loading: false, body: '# Local body' })
    )

    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click()
    })

    expect(document.body.querySelector('[data-testid="preview-state"]')?.textContent).toBe(
      JSON.stringify({ open: false, loading: false, body: '# Local body' })
    )
  })

  it('isolates a failed candidate so the next candidate can still preview', async () => {
    const goodContent = {
      name: 'Good',
      description: '',
      sourceLabel: 'source/good',
      metadata: {},
      body: '# Good body',
      files: ['SKILL.md']
    }
    const Harness = (): React.JSX.Element => {
      const preview = useSkillImportCandidatePreview()
      return (
        <>
          <button
            type="button"
            onClick={() =>
              preview.openPreview(() => {
                throw new Error('Unavailable')
              })
            }
          >
            Bad
          </button>
          <button
            type="button"
            onClick={() => preview.openPreview(() => Promise.resolve(goodContent))}
          >
            Good
          </button>
          <SkillImportCandidatePreview {...preview.previewProps} />
        </>
      )
    }
    act(() => root.render(<Harness />))

    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === 'Bad')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Unavailable')

    act(() => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click()
    })
    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === 'Good')
        ?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Good body')
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })
})
