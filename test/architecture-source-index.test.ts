import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  listProductionSources,
  readProductionSource,
  resetProductionSourceIndexForTests
} from './architecture-source-index'

const projectRoot = resolve(import.meta.dirname, '..')

describe('architecture production source index', () => {
  it('walks src and packages once and reuses the same snapshot', () => {
    resetProductionSourceIndexForTests()
    const first = listProductionSources(projectRoot)
    const second = listProductionSources(projectRoot)
    expect(second).toBe(first)
    expect(first.some((path) => path.replaceAll('\\', '/').endsWith('src/main/index.ts'))).toBe(
      true
    )
    expect(first.every((path) => !/\.(?:test|spec)\.[cm]?tsx?$/.test(path))).toBe(true)
    expect(
      first.every((path) => {
        const relative = path.slice(projectRoot.length).replaceAll('\\', '/')
        return relative.startsWith('/src/') || relative.startsWith('/packages/')
      })
    ).toBe(true)
  })

  it('reuses file contents so architecture cases do not re-read the tree', () => {
    resetProductionSourceIndexForTests()
    const [path] = listProductionSources(projectRoot)
    expect(path).toBeDefined()
    const contents = readProductionSource(path!, projectRoot)
    expect(contents).toBe(readFileSync(path!, 'utf8'))
    expect(readProductionSource(path!, projectRoot)).toBe(contents)
  })
})

it('keeps full-repo architecture scans on the shared index', () => {
  const walkers = [
    'src/main/settings/provider-loopback-http-host.architecture.test.ts',
    'src/main/settings/backend-route-planner.architecture.test.ts',
    'src/main/reviewer/reviewer-orchestrator.architecture.test.ts',
    'src/main/skills/user-skill-repository.architecture.test.ts'
  ]
  for (const relativePath of walkers) {
    expect(readFileSync(resolve(projectRoot, relativePath), 'utf8'), relativePath).toContain(
      'listProductionSources'
    )
  }
})
