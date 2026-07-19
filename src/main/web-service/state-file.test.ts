import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  readWebServiceState,
  removeWebServiceState,
  statePathFor,
  writeWebServiceState
} from './state-file'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('web service state file', () => {
  it('writes, reads, and removes a live state atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-state-'))
    roots.push(root)
    const state = await writeWebServiceState(root, {
      pid: process.pid,
      port: 44100,
      startedAt: '2026-07-19T00:00:00.000Z',
      appVersion: '0.4.0'
    })

    expect(state.configRoot).toBe(root)
    expect(await readWebServiceState(root)).toEqual(state)
    expect(JSON.parse(await readFile(statePathFor(root), 'utf8'))).toEqual(state)

    await removeWebServiceState(root)
    expect(await readWebServiceState(root)).toBeUndefined()
  })

  it('removes stale and invalid state files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-state-'))
    roots.push(root)
    await writeFile(
      statePathFor(root),
      JSON.stringify({
        pid: 2_147_483_647,
        port: 44100,
        startedAt: '2026-07-19T00:00:00.000Z',
        appVersion: '0.4.0',
        configRoot: root
      })
    )
    expect(await readWebServiceState(root)).toBeUndefined()

    await writeFile(statePathFor(root), '{broken')
    expect(await readWebServiceState(root)).toBeUndefined()
  })
})
