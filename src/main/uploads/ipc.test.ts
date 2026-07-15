import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ homePath: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.homePath,
    isPackaged: false
  },
  ipcMain: { handle: vi.fn() }
}))

import { DEV_SESSION_DIR_NAME } from '../session-persistence/repository'
import { createDefaultUploadRepository } from './ipc'

describe('default upload repository', () => {
  let homeRoot: string | undefined

  afterEach(async () => {
    if (homeRoot) await rm(homeRoot, { recursive: true, force: true })
    homeRoot = undefined
  })

  it('stores and previews uploads under the dev-aware storage root', async () => {
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

    expect(attachment.path).toBe(
      join(
        homeRoot,
        DEV_SESSION_DIR_NAME,
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
})
