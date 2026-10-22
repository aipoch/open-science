import { describe, expect, it, vi } from 'vitest'
import {
  AuthorizedDirectoryDiscovery,
  type AuthorizedDirectoriesSnapshot
} from './authorized-directories'

const snapshot = (revision: string): AuthorizedDirectoriesSnapshot => ({
  revision,
  directories: []
})

describe('authorized directory discovery', () => {
  it('distinguishes an empty successful query from failure and retries failures', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(snapshot('a'))
    const discovery = new AuthorizedDirectoryDiscovery(read)
    await expect(discovery.query('one')).rejects.toThrow('database unavailable')
    await expect(discovery.query('one')).resolves.toEqual(snapshot('a'))
  })

  it('coalesces changes per conversation and commits only the acknowledged revision', async () => {
    let revision = 'a'
    const discovery = new AuthorizedDirectoryDiscovery(async () => snapshot(revision))
    expect(await discovery.prepareNotice('one')).toBeUndefined()
    await discovery.query('one')
    await discovery.query('two')
    revision = 'b'
    revision = 'c'
    const pending = await discovery.prepareNotice('one')
    expect(pending?.text).toBe('Local directory authorization has changed.')
    // Failed/cancelled delivery leaves the notice available for retry.
    expect(await discovery.prepareNotice('one')).toBeDefined()
    revision = 'd'
    await pending!.commit()
    const next = await discovery.prepareNotice('one')
    expect(next).toBeDefined()
    await next!.commit()
    expect(await discovery.prepareNotice('one')).toBeUndefined()
    expect(await discovery.prepareNotice('two')).toBeDefined()
    // Querying and notification acknowledgement are independent.
    await expect(discovery.query('one')).resolves.toEqual(snapshot('d'))
    revision = 'e'
    await discovery.query('one')
    expect(await discovery.prepareNotice('one')).toBeDefined()
  })

  it('does not let an older acknowledgement overwrite a newer one', async () => {
    let revision = 'a'
    const discovery = new AuthorizedDirectoryDiscovery(async () => snapshot(revision))
    await discovery.query('one')
    revision = 'b'
    const old = await discovery.prepareNotice('one')
    revision = 'c'
    const current = await discovery.prepareNotice('one')
    await current!.commit()
    await old!.commit()
    expect(await discovery.prepareNotice('one')).toBeUndefined()
  })
  it('retries failed receipt writes without advancing notification state', async () => {
    let revision = 'a'
    const save = vi.fn(async () => {})
    const discovery = new AuthorizedDirectoryDiscovery(async () => snapshot(revision), {
      load: async () => undefined,
      save
    })
    await discovery.query('one')
    revision = 'b'
    const notice = await discovery.prepareNotice('one')
    save.mockRejectedValueOnce(new Error('database busy'))
    await expect(notice!.commit()).rejects.toThrow('database busy')
    const retry = await discovery.prepareNotice('one')
    expect(retry).toBeDefined()
    await retry!.commit()
    expect(await discovery.prepareNotice('one')).toBeUndefined()
  })

  it('serializes overlapping receipt writes and newer queries without losing either version', async () => {
    let revision = 'a'
    let saved: { queriedRevision?: string; notifiedRevision?: string } = {}
    let release!: () => void
    let writing!: () => void
    const started = new Promise<void>((resolve) => {
      writing = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const discovery = new AuthorizedDirectoryDiscovery(async () => snapshot(revision), {
      load: async () => undefined,
      save: async (_sessionId, state) => {
        if (state.notifiedRevision === 'b' && state.queriedRevision === 'a') {
          writing()
          await held
        }
        saved = { ...state }
      }
    })
    await discovery.query('one')
    revision = 'b'
    const first = await discovery.prepareNotice('one')
    const pendingAck = first!.commit()
    await started
    revision = 'c'
    const query = discovery.query('one')
    const notice = discovery.prepareNotice('one')
    release()
    await pendingAck
    await query
    await (await notice)!.commit()
    expect(saved).toMatchObject({ queriedRevision: 'c', notifiedRevision: 'c' })
    expect(await discovery.prepareNotice('one')).toBeUndefined()
  })
})
