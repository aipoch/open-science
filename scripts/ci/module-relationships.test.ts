import { expect, it } from 'vitest'
import { boundaryViolations, dependencyLayer } from './module-relationships.mjs'
import { createConsumerDependencyReader } from './consumer-retirement.mjs'

it('rejects reversed layers and private cross-owner imports, including type relationships', () => {
  const modules = {
    pdf_documents: {
      ownerPaths: ['src/main/pdf-documents/api.ts', 'src/main/pdf-documents/internal.ts'],
      interfacePaths: ['src/main/pdf-documents/api.ts']
    }
  }
  const edges = new Map([
    ['src/shared/in-flight-promise.ts', new Set(['src/shared/contract.ts'])],
    ['src/shared/contract.ts', new Set(['src/main/service.ts'])],
    [
      'src/main/service.ts',
      new Set(['src/main/composition/document-reading.ts', 'src/main/pdf-documents/internal.ts'])
    ],
    ['src/main/composition/document-reading.ts', new Set(['src/main/pdf-documents/api.ts'])],
    ['src/main/pdf-documents/api.ts', new Set(['src/main/pdf-documents/internal.ts'])]
  ])
  expect(boundaryViolations(edges, modules)).toHaveLength(4)
  expect(
    boundaryViolations(
      new Map([
        ['src/main/composition/document-reading.ts', new Set(['src/main/service.ts'])],
        ['src/main/service.ts', new Set(['src/shared/ports.ts', 'src/main/pdf-documents/api.ts'])],
        ['src/renderer/src/store.ts', new Set(['src/shared/contract.ts'])]
      ]),
      modules
    )
  ).toEqual([])
  expect(dependencyLayer('src/main/service.test.ts')).toBe('test')
})

it.each([
  ["import type { Value } from './owner'", false],
  ["import { type Value } from './owner'", false],
  ["export { type Value } from './owner'", false],
  ["export type * from './owner'", false],
  ["import { type Value, schema } from './owner'", true],
  ["import Default, { type Value } from './owner'", true],
  ["export { type Value, schema } from './owner'", true],
  ["import './owner'", true],
  ["import {} from './owner'", true],
  ["export {} from './owner'", true],
  ["export * from './owner'", true],
  ["vi.mock('./owner')", true]
])('separates types from runtime dependencies without dropping effects: %s', (text, reachable) => {
  const contents = new Map([
    ['src/test.ts', String(text)],
    ['src/owner.ts', 'export const schema = 1; export type Value = string']
  ])
  const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
  const owners = new Set(['src/owner.ts'])
  expect(createConsumerDependencyReader(source, [])('src/test.ts', owners).reachable).toBe(true)
  expect(
    createConsumerDependencyReader(source, [], { runtimeOnly: true })('src/test.ts', owners)
      .reachable
  ).toBe(reachable)
  expect(
    createConsumerDependencyReader(source, [['src/owner.ts', ['src/test.ts']]], {
      runtimeOnly: true
    })('src/test.ts', owners).reachable
  ).toBe(true)
})
