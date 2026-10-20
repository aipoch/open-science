import { expect, it, vi } from 'vitest'
import { open } from 'node:fs/promises'
import { DurableJsonReadLimitError, readFileWithinLimit } from './index'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  open: vi.fn()
}))

it('enforces the limit when a file grows during reads and closes the handle', async () => {
  const close = vi.fn().mockResolvedValue(undefined)
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
    buffer.fill(97, offset, offset + length)
    return { bytesRead: length, buffer }
  })
  vi.mocked(open).mockResolvedValue({
    stat: vi.fn().mockResolvedValue({ size: 1, isFile: () => true }),
    read,
    close
  } as unknown as Awaited<ReturnType<typeof open>>)
  await expect(readFileWithinLimit('growing.json', 2)).rejects.toBeInstanceOf(
    DurableJsonReadLimitError
  )
  expect(read).toHaveBeenCalledWith(expect.any(Buffer), 0, 3, null)
  expect(close).toHaveBeenCalledOnce()
})

it('closes a non-regular file without attempting a read', async () => {
  const close = vi.fn().mockResolvedValue(undefined)
  const read = vi.fn()
  vi.mocked(open).mockResolvedValue({
    stat: vi.fn().mockResolvedValue({ size: 0, isFile: () => false }),
    read,
    close
  } as unknown as Awaited<ReturnType<typeof open>>)
  await expect(readFileWithinLimit('directory', 10)).rejects.toThrow('not a regular file')
  expect(read).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})
