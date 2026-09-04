// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installStreamdown } from './install-streamdown'
import { resolveLanguageIconPath } from './language-icons'

let uninstall: (() => void) | undefined

const createCodeBlock = (language?: string): HTMLElement => {
  const root = document.createElement('div')
  root.className = 'agent-markdown-root'
  const block = document.createElement('div')
  block.dataset.streamdown = 'code-block'
  if (language !== undefined) block.dataset.language = language
  const actions = document.createElement('div')
  actions.dataset.streamdown = 'code-block-actions'
  actions.appendChild(document.createElement('button'))
  block.appendChild(actions)
  root.appendChild(block)
  document.body.appendChild(root)
  return actions
}

const flushMutations = (): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })

beforeEach(() => {
  uninstall = installStreamdown()
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
})

describe('code block language badge', () => {
  it('prepends a monochrome icon with the language on the native title', async () => {
    const actions = createCodeBlock('python')
    await flushMutations()

    const badge = actions.querySelector('[data-lang-icon]')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('title')).toBe('python')
    expect(badge?.getAttribute('aria-label')).toBe('python')
    expect(badge?.querySelector('svg')).not.toBeNull()
    expect(actions.firstElementChild).toBe(badge)
  })

  it('uses the language-specific monochrome icon when the language is known', async () => {
    const actions = createCodeBlock('python')
    await flushMutations()

    const svg = actions.querySelector('[data-lang-icon] svg')
    expect(svg?.getAttribute('fill')).toBe('currentColor')
    expect(svg?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100)
  })

  it('resolves fence aliases to their language icon', async () => {
    const actions = createCodeBlock('js')
    await flushMutations()

    expect(actions.querySelector('[data-lang-icon] svg')?.getAttribute('fill')).toBe('currentColor')
  })

  it('falls back to the generic code icon for unmapped languages', async () => {
    const actions = createCodeBlock('cobol')
    await flushMutations()

    const badge = actions.querySelector('[data-lang-icon]')
    expect(badge?.getAttribute('title')).toBe('cobol')
    const svg = badge?.querySelector('svg')
    expect(svg?.getAttribute('fill')).toBe('none')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
  })

  it('skips code blocks without a language', () => {
    const actions = createCodeBlock()

    expect(actions.querySelector('[data-lang-icon]')).toBeNull()
  })

  it('decorates code blocks added after install', async () => {
    const actions = createCodeBlock('html')
    await flushMutations()

    expect(actions.querySelector('[data-lang-icon]')?.getAttribute('title')).toBe('html')
  })

  it('decorates each actions chip only once', async () => {
    const actions = createCodeBlock('rust')
    await flushMutations()

    expect(actions.querySelectorAll('[data-lang-icon]')).toHaveLength(1)
  })

  it('covers the TIOBE top-10 languages and common aliases', () => {
    // TIOBE index top 10: Python, C++, C, Java, C#, JavaScript, Go, Visual Basic, SQL,
    // Delphi/Object Pascal — plus the explicitly requested JSON, R, TS.
    const languages = [
      'python',
      'c++',
      'c',
      'java',
      'c#',
      'javascript',
      'go',
      'visual basic',
      'sql',
      'delphi',
      'pascal',
      'json',
      'r',
      'typescript'
    ]
    for (const language of languages) {
      expect(resolveLanguageIconPath(language), language).not.toBeNull()
    }
  })

  it('removes badges on uninstall', async () => {
    const actions = createCodeBlock('go')
    await flushMutations()
    expect(actions.querySelector('[data-lang-icon]')).not.toBeNull()

    uninstall?.()
    uninstall = undefined

    expect(actions.querySelector('[data-lang-icon]')).toBeNull()
    expect(actions.hasAttribute('data-lang-badge')).toBe(false)
  })
})
