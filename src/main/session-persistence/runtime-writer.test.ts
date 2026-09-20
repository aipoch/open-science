import { describe, expect, it } from 'vitest'
import { RuntimeWriterOwner } from './runtime-writer'
import { RUNTIME_WRITER_LEASE_MS, RUNTIME_WRITER_LOST } from '../../shared/runtime-writer'
describe('runtime projection writer ownership', () => {
  it('gives one client the writer token and keeps other windows read-only', () => {
    const owner = new RuntimeWriterOwner()
    const desktop = owner.claim('electron:1')
    expect(desktop.token).toBeTruthy()
    expect(owner.claim('web:phone').token).toBeUndefined()
    expect(owner.claim('web:second').token).toBeUndefined()
    expect(owner.claim('electron:1').token).toBe(desktop.token)
  })
  it('supports a web writer when there is no desktop and rejects stale or stolen tokens', async () => {
    let now = 0
    const owner = new RuntimeWriterOwner(() => now)
    const first = owner.claim('web:first')
    await expect(owner.commit('web:other', first.token!, async () => 'bad')).rejects.toMatchObject({
      code: RUNTIME_WRITER_LOST
    })
    now = RUNTIME_WRITER_LEASE_MS + 1
    const next = owner.claim('web:other')
    expect(next.token).toBeTruthy()
    expect(next.token).not.toBe(first.token)
    await expect(owner.commit('web:first', first.token!, async () => 'bad')).rejects.toMatchObject({
      code: RUNTIME_WRITER_LOST
    })
    await expect(owner.commit('web:other', next.token!, async () => 'saved')).resolves.toBe('saved')
  })
  it('does not elect a successor while an accepted write is still committing', async () => {
    let now = 0
    const owner = new RuntimeWriterOwner(() => now)
    const first = owner.claim('electron:1')
    let finish!: () => void
    const writing = owner.commit(
      'electron:1',
      first.token!,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    now = RUNTIME_WRITER_LEASE_MS + 1
    expect(owner.claim('web:phone').token).toBeUndefined()
    finish()
    await writing
    expect(owner.claim('web:phone').token).toBeTruthy()
  })
})

it('keeps a living desktop writer despite background timer throttling and replaces a destroyed one', async () => {
  let now = 0
  let alive = true
  const owner = new RuntimeWriterOwner(
    () => now,
    undefined,
    (id) => (id.startsWith('electron:') ? alive : undefined)
  )
  const desktop = owner.claim('electron:1')
  now = RUNTIME_WRITER_LEASE_MS * 10
  expect(owner.claim('web:phone').token).toBeUndefined()
  await expect(owner.commit('electron:1', desktop.token!, async () => 'saved')).resolves.toBe(
    'saved'
  )
  alive = false
  expect(owner.claim('web:phone').token).toBeTruthy()
  await expect(
    owner.commit('electron:1', desktop.token!, async () => 'stale')
  ).rejects.toMatchObject({ code: RUNTIME_WRITER_LOST })
})
