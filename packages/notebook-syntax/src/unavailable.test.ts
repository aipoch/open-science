import { expect, it, vi } from 'vitest'
vi.mock('web-tree-sitter', () => {
  throw Object.assign(new Error('Runtime unavailable'), { code: 'MODULE_NOT_FOUND' })
})
it('returns unavailable when the declared parser runtime cannot load', async () => {
  const { withParsedNotebookSource } = await import('./index.js')
  await expect(withParsedNotebookSource('python', 'x = 1', () => true)).resolves.toEqual({
    state: 'error',
    reason: 'parser-unavailable'
  })
})
