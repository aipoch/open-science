import { randomUUID } from 'node:crypto'
import { link, rm } from 'node:fs/promises'
import type { EncoriPublisher } from './publication'
export const publishTestFile: EncoriPublisher = async (destination, write, signal) => {
  const temporary = destination + '.' + randomUUID() + '.tmp'
  try {
    await write(temporary)
    signal?.throwIfAborted()
    await link(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}
