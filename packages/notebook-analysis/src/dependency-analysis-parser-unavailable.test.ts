import { describe, expect, it, vi } from 'vitest'

vi.mock('@aipoch/notebook-syntax', () => ({
  withParsedNotebookSource: async () => ({ state: 'error', reason: 'parser-unavailable' })
}))

describe('Notebook dependency analysis parser availability', () => {
  it('degrades to unknown when the parser runtime cannot load', async () => {
    const { analyzePythonSources } = await import('./dependency-analysis-python.js')

    await expect(analyzePythonSources(['result = source + 1'])).resolves.toEqual([
      { state: 'unknown', reasons: ['parser-unavailable'] }
    ])
  })
})
