import { expect, it } from 'vitest'
import { createPdfStructureEngine } from './engine'

it('resolves the packaged worker with the host model recipe', async () => {
  const recipe = await createPdfStructureEngine().describe()
  expect(recipe.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(recipe.modelRevision).toBe('pdf-figures-tables-v1')
})
