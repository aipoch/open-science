import { expect, it } from 'vitest'
import { createConsumerDependencyReader } from './consumer-retirement.mjs'

function graph(
  text: string,
  runtimeOnly: boolean
): ReturnType<typeof createConsumerDependencyReader> {
  const files = {
    'src/test.ts': text,
    'src/value.ts': 'export const value = 1; export type Value = number',
    'src/adapter.ts': "import type { Value } from './value'; export const adapter = 1"
  }
  return createConsumerDependencyReader(
    {
      files: new Set(Object.keys(files)),
      read: (path: string) => files[path as keyof typeof files]
    },
    [],
    { runtimeOnly }
  )
}

it.each([
  "import type { Value } from './value'",
  "export type { Value } from './value'",
  "export type * from './value'",
  "type Value = import('./value').Value"
])('separates erased type references without changing the structural graph: %s', (text) => {
  expect(graph(text, true)('src/test.ts', new Set(['src/value.ts'])).reachable).toBe(false)
  expect(graph(text, false)('src/test.ts', new Set(['src/value.ts'])).reachable).toBe(true)
})

it.each([
  "import './value'",
  "import { value, type Value } from './value'",
  "export * from './value'",
  "import('./value')",
  "const value = require('./value')",
  "vi.mock('./value', () => ({}))",
  "vi.importActual('./value')",
  "import type { Value } from './value'; import './value'",
  "import './adapter'; export { value } from './value'"
])('retains runtime and alternate dependency paths: %s', (text) => {
  expect(graph(text, true)('src/test.ts', new Set(['src/value.ts'])).reachable).toBe(true)
})

it('retains uncertainty rather than proving a missing dynamic or local import absent', () => {
  for (const text of [
    'import(name)',
    "import './missing'",
    "import 'an-opaque-runtime'",
    "import { readFileSync } from 'node:fs'"
  ])
    expect(graph(text, true)('src/test.ts', new Set(['src/value.ts'])).complete).toBe(false)
})

it('keeps allowlisted test utilities and erased external types complete', () => {
  for (const text of [
    "import { expect } from 'vitest'",
    "import { join } from 'node:path'",
    "import type { Value } from 'an-opaque-runtime'"
  ])
    expect(graph(text, true)('src/test.ts', new Set(['src/value.ts'])).complete).toBe(true)
})
