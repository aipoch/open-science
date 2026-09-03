// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installStreamdown } from './install-streamdown'

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
