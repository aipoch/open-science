import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateRendererApiMap } from './generate-web-api-map.mjs'

const directories: string[] = []
async function fixture(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-contract-'))
  directories.push(directory)
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source)
  return join(directory, 'catalog.ts')
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('Web API map generation', () => {
  it('projects explicit capability modules without evaluating their code', async () => {
    const path = await fixture({
      'catalog.ts': `import * as first from './first'
        import * as second from './second'
        export const RENDERER_API_CONTRACT = composeRendererApiContract(first.contract, second.contract)`,
      'first.ts': `throw new Error('must not execute');
        export const contract = { 'feature.get': callable<() => void>()('feature', ['feature:get']) } as const`,
      'second.ts': `export const contract = Object.freeze({
        'feature.onChanged': callable<() => void>()('feature', ['feature:changed', EVENT]),
        'feature.local': callable<() => void>()('feature', ['feature:local', ELECTRON]),
        platform: value<string>()('platform')
      })`
    })
    const output = await generateRendererApiMap(path)
    expect(output).toContain("'feature.get': 'feature:get'")
    expect(output).toContain("'feature.onChanged': 'feature:changed'")
    expect(output).not.toContain('feature.local')
    expect(output).not.toContain('platform')
  })

  it('retains literal catalogs and explicit local spreads', async () => {
    const path = await fixture({
      'catalog.ts': `const extra = { 'feature.get': callable<() => void>()('feature', ['feature:get']) }
        export const RENDERER_API_CONTRACT = Object.freeze({ ...extra } as const)`
    })
    expect(await generateRendererApiMap(path)).toContain("'feature.get': 'feature:get'")
  })

  it.each([
    [
      'duplicate',
      `const entry = {'feature.get': callable<() => void>()('feature', ['feature:get'])};
      export const RENDERER_API_CONTRACT = composeRendererApiContract(entry, entry)`,
      'Duplicate renderer contract path'
    ],
    [
      'cycle',
      `const first = {...second}; const second = {...first};
      export const RENDERER_API_CONTRACT = first`,
      'Circular renderer contract definition'
    ],
    [
      'dynamic',
      'export const RENDERER_API_CONTRACT = readFromNetwork()',
      'Unsupported renderer contract definition'
    ],
    [
      'unknown profile',
      `export const RENDERER_API_CONTRACT = {'feature.get': callable<() => void>()('feature', ['feature:get', UNKNOWN])}`,
      'Unknown renderer contract profile'
    ]
  ])('rejects %s definitions', async (_name, source, error) => {
    const path = await fixture({ 'catalog.ts': source })
    await expect(generateRendererApiMap(path)).rejects.toThrow(error)
  })
})
