import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { saveRaw } from './client'
import type { EncoriContext } from './publication'
import { publishTestFile } from './publication.test-helper'

it('propagates raw-response publication cancellation and leaves no published result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'encori-publication-'))
  const controller = new AbortController()
  try {
    const ctx = {
      signal: controller.signal,
      publishFile: (destination, write, signal) =>
        publishTestFile(
          destination,
          async (temporary) => {
            await write(temporary)
            controller.abort(new Error('cancel raw response'))
          },
          signal
        )
    } as EncoriContext
    await expect(saveRaw(Buffer.from('official bytes'), 'fixture', directory, ctx)).rejects.toThrow(
      'cancel raw response'
    )
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
