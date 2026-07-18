import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ homePath: '' }))
const ipcHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, request: unknown) => unknown>()
)

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.homePath,
    isPackaged: false
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) =>
      ipcHandlers.set(channel, handler)
    )
  }
}))

import { dataFolderName } from '../storage-root'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './ipc'
import type { UploadRepository } from './repository'

describe('default upload repository', () => {
  let homeRoot: string | undefined

  afterEach(async () => {
    ipcHandlers.clear()
    clearMigrationPending()
    if (homeRoot) await rm(homeRoot, { recursive: true, force: true })
    homeRoot = undefined
  })

  it('stores and previews uploads under the default data root', async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-ipc-'))
    electronState.homePath = homeRoot
    const repository = createDefaultUploadRepository()
    const content = 'event,count\nheadache,4\n'

    const [attachment] = await repository.stageFiles({
      files: [
        {
          name: 'adverse_events.csv',
          mimeType: 'text/csv',
          content: Buffer.from(content).toString('base64')
        }
      ]
    })

    // Uploads follow the configurable data root; a fresh dev install defaults to <home>/OpenScience-DEV.
    expect(attachment.path).toBe(
      join(
        homeRoot,
        dataFolderName(),
        'uploads',
        'default-project',
        '.pending',
        'adverse_events.csv'
      )
    )
    await expect(
      repository.readManagedUploadPreview({ path: attachment.path, encoding: 'utf8' })
    ).resolves.toMatchObject({ content })
  })

  it('keeps migration drain pending until an upload that already started finishes', async () => {
    let releaseUpload: (() => void) | undefined
    const repository = {
      stageFiles: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseUpload = resolve
          })
      )
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stage = ipcHandlers.get('uploads:stage-files')!

    const uploadPromise = Promise.resolve(stage(undefined, { files: [] }))
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    releaseUpload?.()
    await uploadPromise
    await drainPromise
    expect(drained).toBe(true)
  })
})
