import { describe, expect, it, vi } from 'vitest'
import { AuthorizedDirectoryNotices } from './authorized-directories'

describe('authorized directory notices', () => {
  it('coalesces changes per live session and acknowledges only the sent revision', async () => {
    let revision = 'a'
    const notices = new AuthorizedDirectoryNotices(async () => ({ revision, directories: [] }))
    const one = {},
      two = {}
    await notices.initialize(one)
    await notices.initialize(two)
    expect(await notices.prepareNotice(one)).toBeUndefined()
    revision = 'b'
    revision = 'c'
    const pending = await notices.prepareNotice(one)
    expect(pending?.text).toBe('Local directory authorization has changed.')
    // Failure or cancellation does not acknowledge delivery.
    expect(await notices.prepareNotice(one)).toBeDefined()
    revision = 'd'
    pending!.commit()
    const next = await notices.prepareNotice(one)
    expect(next).toBeDefined()
    next!.commit()
    expect(await notices.prepareNotice(one)).toBeUndefined()
    expect(await notices.prepareNotice(two)).toBeDefined()
    pending!.commit()
    expect(await notices.prepareNotice(one)).toBeUndefined()
  })

  it('initializes a restored attachment independently of the old attachment', async () => {
    let revision = 'a'
    const notices = new AuthorizedDirectoryNotices(async () => ({ revision, directories: [] }))
    const session = {}
    await notices.initialize(session)
    revision = 'b'
    const old = await notices.prepareNotice(session)
    revision = 'c'
    const restored = {}
    await notices.initialize(restored)
    old!.commit()
    expect(await notices.prepareNotice(restored)).toBeUndefined()
    revision = 'd'
    expect(await notices.prepareNotice(restored)).toBeDefined()
  })

  it('preserves pending changes when an already active attachment is resumed again', async () => {
    let revision = 'a'
    const notices = new AuthorizedDirectoryNotices(async () => ({ revision, directories: [] }))
    const session = {}
    await notices.initialize(session)
    revision = 'b'
    await notices.initialize(session)
    expect(await notices.prepareNotice(session)).toBeDefined()
  })

  it('does not acknowledge changes when the records cannot be read', async () => {
    const read = vi.fn().mockResolvedValue({ revision: 'a', directories: [] })
    const notices = new AuthorizedDirectoryNotices(read)
    const session = {}
    await notices.initialize(session)
    read.mockRejectedValueOnce(new Error('records unavailable'))
    await expect(notices.prepareNotice(session)).rejects.toThrow('records unavailable')
    read.mockResolvedValue({ revision: 'b', directories: [] })
    expect(await notices.prepareNotice(session)).toBeDefined()
  })
})
