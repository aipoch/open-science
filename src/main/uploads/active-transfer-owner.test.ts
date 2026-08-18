import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: vi.fn(actual.rm)
  }
})

import { ActiveTransferOwner } from './active-transfer-owner'

const actualFsPromises =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let storageRoot: string | undefined

afterEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(actualFsPromises.rm)
  if (storageRoot) await actualFsPromises.rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('ActiveTransferOwner staging initialization', () => {
  it('retries initialization after a transient filesystem failure', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
    const owner = new ActiveTransferOwner(storageRoot)
    const transientFailure = new Error('transient staging cleanup failure')
    vi.mocked(rm).mockRejectedValueOnce(transientFailure)

    const request = { transferId: 'retry-transfer', name: 'data.csv', size: 1 }

    await expect(owner.beginTransfer(request)).rejects.toBe(transientFailure)
    await expect(owner.beginTransfer(request)).resolves.toMatchObject({
      transferId: request.transferId,
      receivedBytes: 0,
      totalBytes: request.size
    })
    expect(rm).toHaveBeenCalledTimes(2)

    await owner.abortTransfer({ transferId: request.transferId })
  })
})
