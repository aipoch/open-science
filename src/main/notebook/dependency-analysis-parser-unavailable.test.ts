import { describe, expect, it, vi } from 'vitest'

vi.mock('web-tree-sitter', () => {
  throw Object.assign(new Error("Cannot find module 'web-tree-sitter'"), {
    code: 'MODULE_NOT_FOUND'
  })
})

describe('Notebook dependency analysis parser availability', () => {
  it('degrades to unknown when the parser runtime cannot load', async () => {
    const { analyzePythonSources } = await import('./dependency-analysis-python')

    await expect(analyzePythonSources(['result = source + 1'])).resolves.toEqual([
      { state: 'unknown', reasons: ['parser-unavailable'] }
    ])
  })
})
