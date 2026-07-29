import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  activateRollbackConfig,
  convertSessionToV073,
  runRollbackToV073
} from './rollback-to-0.7.3.mjs'

const temporaryRoots: string[] = []
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const temporaryRoot = async (): Promise<string> => {
  const root = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'open-science-rollback-'))
  )
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('rollback-to-0.7.3', () => {
  it('preserves both recovery candidates when activation and automatic restoration fail', async () => {
    const renamePath = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('activation failed'))
      .mockRejectedValueOnce(new Error('restoration failed'))

    await expect(
      activateRollbackConfig({
        configRoot: '/config',
        preservedConfigRoot: '/config.before-rollback',
        stagingConfigRoot: '/config.rollback-staging',
        renamePath
      })
    ).rejects.toMatchObject({
      code: 'rollback_cutover_recovery_required',
      preserveRollbackState: true,
      message: expect.stringContaining('Prepared 0.7.3 Config Root: /config.rollback-staging')
    })
    expect(renamePath.mock.calls).toEqual([
      ['/config', '/config.before-rollback'],
      ['/config.rollback-staging', '/config'],
      ['/config.before-rollback', '/config']
    ])
  })

  it('projects the active Session branch into a v1 envelope and materializes Version paths', () => {
    const converted = convertSessionToV073(
      {
        version: 2,
        session: {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Sine',
          cwd: '/data/notebooks/project-1/session-1',
          status: 'idle',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Use the data',
              status: 'complete',
              eventIds: [],
              uploads: [
                {
                  id: 'upload-1',
                  versionId: 'upload-version-1',
                  sessionId: 'session-1',
                  name: 'data.csv',
                  originalName: 'data.csv',
                  size: 12,
                  sha256: 'upload-checksum'
                }
              ],
              parts: [
                {
                  type: 'artifact',
                  id: 'artifact-1',
                  name: 'plot.png',
                  source: 'artifact',
                  path: 'artifact-version:artifact-version-1',
                  versionId: 'artifact-version-1'
                }
              ],
              createdAt: 1,
              updatedAt: 1
            }
          ],
          conversationGraph: { schemaVersion: 1, messages: [{ id: 'inactive-message' }] },
          artifacts: [
            {
              id: 'artifact-version-1',
              artifactId: 'artifact-1',
              versionId: 'artifact-version-1',
              versionNumber: 2,
              kind: 'managed-file',
              path: 'artifact-version:artifact-version-1',
              name: 'plot.png'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      },
      {
        sourceDataRoot: '/data',
        rollbackDataRoot: '/rollback',
        uploadVersions: new Map([
          [
            'upload-version-1',
            {
              storageKey: 'uploads/project-1/session-1/upload-version-1/content',
              sizeBytes: 9n,
              checksum: sha256('csv-bytes')
            }
          ]
        ]),
        artifactVersions: new Map([
          [
            'artifact-version-1',
            {
              storageKey:
                'artifacts/project-1/session-1/.provenance/artifact-1/versions/artifact-version-1/content',
              sizeBytes: 9n,
              checksum: sha256('png-bytes')
            }
          ]
        ])
      }
    ) as {
      version: number
      session: {
        conversationGraph?: unknown
        messages: Array<{
          uploads?: Array<Record<string, unknown>>
          parts?: Array<Record<string, unknown>>
        }>
        artifacts: Array<Record<string, unknown>>
      }
    }

    expect(converted.version).toBe(1)
    expect(converted.session.conversationGraph).toBeUndefined()
    expect(converted.session.messages[0].uploads).toEqual([
      expect.objectContaining({
        id: 'upload-1',
        path: '$DATA/uploads/project-1/session-1/upload-version-1/content',
        checksum: 'upload-checksum'
      })
    ])
    expect(converted.session.messages[0].uploads?.[0]).not.toHaveProperty('versionId')
    expect(converted.session.messages[0].parts?.[0]).toMatchObject({
      path: join(
        '/rollback',
        'artifacts/project-1/session-1/.provenance/artifact-1/versions/artifact-version-1/content'
      )
    })
    expect(converted.session.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-version-1',
        path: '$DATA/artifacts/project-1/session-1/.provenance/artifact-1/versions/artifact-version-1/content'
      })
    ])
    expect(converted.session.artifacts[0]).not.toHaveProperty('artifactId')
    expect(converted.session.artifacts[0]).not.toHaveProperty('versionId')
  })

  it('creates and activates an isolated 0.7.3 data root while preserving newer data', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    await mkdir(join(configRoot, 'sessions', 'project-1'), { recursive: true })
    await mkdir(join(dataRoot, 'uploads', 'project-1', 'session-1', 'upload-version-1'), {
      recursive: true
    })
    await mkdir(
      join(
        dataRoot,
        'artifacts',
        'project-1',
        'session-1',
        '.provenance',
        'artifact-1',
        'versions',
        'artifact-version-1'
      ),
      { recursive: true }
    )
    await mkdir(join(dataRoot, 'runtime', 'envs', 'default-python'), { recursive: true })
    await writeFile(
      join(dataRoot, 'uploads', 'project-1', 'session-1', 'upload-version-1', 'content'),
      'csv-bytes'
    )
    await writeFile(
      join(
        dataRoot,
        'artifacts',
        'project-1',
        'session-1',
        '.provenance',
        'artifact-1',
        'versions',
        'artifact-version-1',
        'content'
      ),
      'png-bytes'
    )
    await writeFile(join(dataRoot, 'runtime', 'envs', 'default-python', 'python'), 'runtime')
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    await writeFile(join(configRoot, 'keep-newer.txt'), 'newer-state')
    await writeFile(
      join(configRoot, 'sessions', 'project-1', 'session-1.json'),
      JSON.stringify({
        version: 2,
        session: {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Session',
          cwd: '$DATA/workspaces/session-1',
          status: 'idle',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Use data.csv',
              status: 'complete',
              eventIds: [],
              uploads: [
                {
                  id: 'upload-1',
                  versionId: 'upload-version-1',
                  sessionId: 'session-1',
                  name: 'data.csv',
                  originalName: 'data.csv',
                  size: 9
                }
              ],
              createdAt: 1,
              updatedAt: 1
            }
          ],
          conversationGraph: { schemaVersion: 1 },
          artifacts: [
            {
              id: 'artifact-version-1',
              versionId: 'artifact-version-1',
              kind: 'managed-file',
              path: 'artifact-version:artifact-version-1',
              name: 'plot.png'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      })
    )

    const database = new DatabaseSync(join(configRoot, 'open-science.db'))
    database.exec(`
      CREATE TABLE UploadVersion (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        contentStorageKey TEXT NOT NULL,
        sizeBytes BIGINT NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE ArtifactVersion (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        contentStorageKey TEXT NOT NULL,
        sizeBytes BIGINT NOT NULL,
        checksum TEXT NOT NULL
      );
    `)
    database
      .prepare('INSERT INTO UploadVersion VALUES (?, ?, ?, ?, ?)')
      .run(
        'upload-version-1',
        'ready',
        'uploads/project-1/session-1/upload-version-1/content',
        9,
        sha256('csv-bytes')
      )
    database
      .prepare('INSERT INTO ArtifactVersion VALUES (?, ?, ?, ?, ?)')
      .run(
        'artifact-version-1',
        'finalized',
        'artifacts/project-1/session-1/.provenance/artifact-1/versions/artifact-version-1/content',
        9,
        sha256('png-bytes')
      )
    database.close()

    const result = await runRollbackToV073({
      configRoot,
      dataRoot,
      output: rollbackDataRoot,
      confirm: true,
      now: () => Date.UTC(2026, 6, 29, 1, 2, 3),
      removeMarker: vi.fn().mockRejectedValue(new Error('marker is busy'))
    })

    expect(result.targetVersion).toBe('0.7.3')
    expect(result.rollbackDataRoot).toBe(rollbackDataRoot)
    expect(await readFile(join(result.preservedConfigRoot, 'keep-newer.txt'), 'utf8')).toBe(
      'newer-state'
    )
    expect(
      await readFile(join(dataRoot, 'runtime', 'envs', 'default-python', 'python'), 'utf8')
    ).toBe('runtime')
    await expect(stat(join(rollbackDataRoot, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await readFile(
        join(rollbackDataRoot, 'uploads', 'project-1', 'session-1', 'upload-version-1', 'content'),
        'utf8'
      )
    ).toBe('csv-bytes')

    const converted = JSON.parse(
      await readFile(join(configRoot, 'sessions', 'project-1', 'session-1.json'), 'utf8')
    )
    expect(converted.version).toBe(1)
    expect(converted.session.conversationGraph).toBeUndefined()
    expect(converted.session.messages[0].uploads[0].path).toBe(
      '$DATA/uploads/project-1/session-1/upload-version-1/content'
    )
    expect(converted.session.artifacts[0].path).toContain('$DATA/artifacts/project-1')
    expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')).dataRoot).toBe(
      rollbackDataRoot
    )
    expect(
      JSON.parse(await readFile(join(configRoot, 'rollback-to-0.7.3.json'), 'utf8'))
    ).toMatchObject({
      targetVersion: '0.7.3',
      originalConfigRoot: configRoot,
      preservedConfigRoot: result.preservedConfigRoot,
      originalDataRoot: dataRoot,
      rollbackDataRoot
    })
    await expect(stat(`${configRoot}.rollback-to-0.7.3.pending.json`)).resolves.toBeDefined()

    await expect(
      runRollbackToV073({
        configRoot,
        output: rollbackDataRoot,
        confirm: true,
        now: () => Date.UTC(2026, 6, 30, 1, 2, 3)
      })
    ).resolves.toEqual(result)
    await expect(stat(`${configRoot}.rollback-to-0.7.3.pending.json`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('removes incomplete copies and leaves the active Config Root unchanged on conversion failure', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    await mkdir(join(configRoot, 'sessions', 'project-1'), { recursive: true })
    await mkdir(join(dataRoot, 'uploads'), { recursive: true })
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    await writeFile(
      join(configRoot, 'sessions', 'project-1', 'session-1.json'),
      JSON.stringify({
        version: 2,
        session: {
          id: 'session-1',
          messages: [
            {
              id: 'message-1',
              uploads: [{ id: 'upload-1', versionId: 'missing-version' }]
            }
          ]
        }
      })
    )
    new DatabaseSync(join(configRoot, 'open-science.db')).close()

    await expect(
      runRollbackToV073({
        configRoot,
        dataRoot,
        output: rollbackDataRoot,
        confirm: true,
        now: () => Date.UTC(2026, 6, 29, 1, 2, 3)
      })
    ).rejects.toThrow('Cannot materialize upload Version missing-version')

    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toContain(dataRoot)
    await expect(stat(rollbackDataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${configRoot}.before-rollback-20260729T010203Z`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects corrupt Version bytes before creating a rollback copy', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    const storageKey = 'uploads/project-1/session-1/upload-version-1/content'
    await mkdir(configRoot, { recursive: true })
    await mkdir(join(dataRoot, 'uploads', 'project-1', 'session-1', 'upload-version-1'), {
      recursive: true
    })
    await writeFile(join(dataRoot, ...storageKey.split('/')), 'corrupt')
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    const database = new DatabaseSync(join(configRoot, 'open-science.db'))
    database.exec(`
      CREATE TABLE UploadVersion (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        contentStorageKey TEXT NOT NULL,
        sizeBytes BIGINT NOT NULL,
        checksum TEXT NOT NULL
      );
    `)
    database
      .prepare('INSERT INTO UploadVersion VALUES (?, ?, ?, ?, ?)')
      .run('upload-version-1', 'ready', storageKey, 7, sha256('expected'))
    database.close()

    await expect(
      runRollbackToV073({
        configRoot,
        dataRoot,
        output: rollbackDataRoot,
        confirm: true
      })
    ).rejects.toThrow('Source Upload Version checksum mismatch: upload-version-1')
    await expect(stat(rollbackDataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an output whose existing parent aliases the Data Root', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const aliasRoot = join(root, 'data-alias')
    await mkdir(configRoot, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await symlink(dataRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    new DatabaseSync(join(configRoot, 'open-science.db')).close()

    await expect(
      runRollbackToV073({
        configRoot,
        dataRoot,
        output: join(aliasRoot, 'rollback'),
        confirm: true
      })
    ).rejects.toThrow('Rollback output must be separate')
    await expect(stat(join(dataRoot, 'rollback'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the original and prepared copies when cutover restoration needs manual recovery', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    const stamp = '20260729T010203Z'
    await mkdir(configRoot, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    new DatabaseSync(join(configRoot, 'open-science.db')).close()
    let renameCall = 0
    const renamePath = vi.fn(async (source: string, target: string) => {
      renameCall += 1
      if (renameCall === 1) return rename(source, target)
      throw new Error(renameCall === 2 ? 'activation failed' : 'restoration failed')
    })

    await expect(
      runRollbackToV073({
        configRoot,
        dataRoot,
        output: rollbackDataRoot,
        confirm: true,
        now: () => Date.UTC(2026, 6, 29, 1, 2, 3),
        renamePath
      })
    ).rejects.toMatchObject({ code: 'rollback_cutover_recovery_required' })

    await expect(stat(configRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${configRoot}.before-rollback-${stamp}`)).resolves.toBeDefined()
    await expect(stat(`${configRoot}.rollback-staging-${stamp}`)).resolves.toBeDefined()
    await expect(stat(rollbackDataRoot)).resolves.toBeDefined()

    await expect(
      runRollbackToV073({ configRoot, output: rollbackDataRoot, confirm: true })
    ).resolves.toMatchObject({ targetVersion: '0.7.3', rollbackDataRoot })
    await expect(stat(configRoot)).resolves.toBeDefined()
    await expect(stat(`${configRoot}.rollback-to-0.7.3.pending.json`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('cleans an interrupted preparation and safely reuses its explicit output', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    const stamp = '20260729T010203Z'
    const preservedConfigRoot = `${configRoot}.before-rollback-${stamp}`
    const stagingConfigRoot = `${configRoot}.rollback-staging-${stamp}`
    const markerPath = `${configRoot}.rollback-to-0.7.3.pending.json`
    await mkdir(configRoot, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await mkdir(stagingConfigRoot, { recursive: true })
    await mkdir(rollbackDataRoot, { recursive: true })
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    await writeFile(join(stagingConfigRoot, 'partial.txt'), 'partial-config')
    await writeFile(join(rollbackDataRoot, 'partial.txt'), 'partial-data')
    new DatabaseSync(join(configRoot, 'open-science.db')).close()
    await writeFile(
      markerPath,
      JSON.stringify({
        schemaVersion: 1,
        phase: 'preparing',
        configRoot,
        preservedConfigRoot,
        stagingConfigRoot,
        rollbackDataRoot
      })
    )

    await expect(
      runRollbackToV073({
        configRoot,
        dataRoot,
        output: rollbackDataRoot,
        confirm: true,
        now: () => Date.UTC(2026, 6, 29, 1, 2, 3)
      })
    ).resolves.toMatchObject({ targetVersion: '0.7.3', rollbackDataRoot })

    await expect(stat(join(configRoot, 'partial.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(rollbackDataRoot, 'partial.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('revalidates prepared Version bytes before recovering a cutover', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    const preservedConfigRoot = `${configRoot}.before-rollback-20260729T010203Z`
    const stagingConfigRoot = `${configRoot}.rollback-staging-20260729T010203Z`
    const markerPath = `${configRoot}.rollback-to-0.7.3.pending.json`
    const marker = {
      schemaVersion: 1,
      configRoot,
      preservedConfigRoot,
      stagingConfigRoot,
      rollbackDataRoot
    }
    const manifest = {
      schemaVersion: 1,
      targetVersion: '0.7.3',
      originalConfigRoot: configRoot,
      preservedConfigRoot,
      originalDataRoot: join(root, 'OpenScience'),
      preservedDataRoot: join(root, 'OpenScience'),
      rollbackDataRoot,
      sessionsConverted: 0
    }
    await mkdir(configRoot, { recursive: true })
    await mkdir(stagingConfigRoot, { recursive: true })
    await mkdir(rollbackDataRoot, { recursive: true })
    await writeFile(join(stagingConfigRoot, 'rollback-to-0.7.3.json'), JSON.stringify(manifest))
    await writeFile(join(rollbackDataRoot, 'rollback-to-0.7.3.json'), JSON.stringify(manifest))
    const database = new DatabaseSync(join(stagingConfigRoot, 'open-science.db'))
    database.exec(`
      CREATE TABLE UploadVersion (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        contentStorageKey TEXT NOT NULL,
        sizeBytes BIGINT NOT NULL,
        checksum TEXT NOT NULL
      );
    `)
    database
      .prepare('INSERT INTO UploadVersion VALUES (?, ?, ?, ?, ?)')
      .run(
        'upload-version-1',
        'ready',
        'uploads/project-1/session-1/upload-version-1/content',
        9,
        sha256('csv-bytes')
      )
    database.close()
    await writeFile(markerPath, JSON.stringify({ ...marker, phase: 'preparing' }))
    await writeFile(`${markerPath}.prepared`, JSON.stringify({ ...marker, phase: 'prepared' }))

    await expect(
      runRollbackToV073({ configRoot, output: rollbackDataRoot, confirm: true })
    ).rejects.toThrow('Prepared Upload Version content is missing: upload-version-1')

    await expect(stat(configRoot)).resolves.toBeDefined()
    await expect(stat(stagingConfigRoot)).resolves.toBeDefined()
    await expect(stat(preservedConfigRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(markerPath)).resolves.toBeDefined()
  })

  it('rechecks that Open Science is closed immediately before cutover', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const dataRoot = join(root, 'OpenScience')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    await mkdir(configRoot, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ version: 2, dataRoot }))
    new DatabaseSync(join(configRoot, 'open-science.db')).close()

    await expect(
      runRollbackToV073({
        configRoot,
        dataRoot,
        output: rollbackDataRoot,
        confirm: true,
        syncPrepared: async () => {
          await writeFile(
            join(configRoot, 'web-service.json'),
            JSON.stringify({ pid: process.pid })
          )
        }
      })
    ).rejects.toThrow('Open Science is still running')

    await expect(stat(configRoot)).resolves.toBeDefined()
    await expect(stat(rollbackDataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rechecks offline state after validating an interrupted prepared copy', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    const preservedConfigRoot = `${configRoot}.before-rollback-20260729T010203Z`
    const stagingConfigRoot = `${configRoot}.rollback-staging-20260729T010203Z`
    const markerPath = `${configRoot}.rollback-to-0.7.3.pending.json`
    const marker = {
      schemaVersion: 1,
      configRoot,
      preservedConfigRoot,
      stagingConfigRoot,
      rollbackDataRoot
    }
    const manifest = {
      schemaVersion: 1,
      targetVersion: '0.7.3',
      originalConfigRoot: configRoot,
      preservedConfigRoot,
      originalDataRoot: join(root, 'OpenScience'),
      preservedDataRoot: join(root, 'OpenScience'),
      rollbackDataRoot,
      sessionsConverted: 0
    }
    await mkdir(configRoot, { recursive: true })
    await mkdir(stagingConfigRoot, { recursive: true })
    await mkdir(rollbackDataRoot, { recursive: true })
    await writeFile(join(configRoot, 'web-service.json'), JSON.stringify({ pid: 424242 }))
    await writeFile(join(stagingConfigRoot, 'rollback-to-0.7.3.json'), JSON.stringify(manifest))
    await writeFile(join(rollbackDataRoot, 'rollback-to-0.7.3.json'), JSON.stringify(manifest))
    new DatabaseSync(join(stagingConfigRoot, 'open-science.db')).close()
    await writeFile(markerPath, JSON.stringify({ ...marker, phase: 'preparing' }))
    await writeFile(`${markerPath}.prepared`, JSON.stringify({ ...marker, phase: 'prepared' }))
    vi.spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        const error = new Error('not running') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      })
      .mockReturnValueOnce(true)

    await expect(
      runRollbackToV073({ configRoot, output: rollbackDataRoot, confirm: true })
    ).rejects.toThrow('Open Science is still running')

    await expect(stat(configRoot)).resolves.toBeDefined()
    await expect(stat(stagingConfigRoot)).resolves.toBeDefined()
    await expect(stat(preservedConfigRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not resume an interrupted cutover while Open Science is running', async () => {
    const root = await temporaryRoot()
    const configRoot = join(root, '.open-science')
    const rollbackDataRoot = join(root, 'OpenScience-Rollback-0.7.3')
    const preservedConfigRoot = `${configRoot}.before-rollback-20260729T010203Z`
    const stagingConfigRoot = `${configRoot}.rollback-staging-20260729T010203Z`
    const markerPath = `${configRoot}.rollback-to-0.7.3.pending.json`
    await mkdir(configRoot, { recursive: true })
    await mkdir(stagingConfigRoot, { recursive: true })
    await mkdir(rollbackDataRoot, { recursive: true })
    await writeFile(join(configRoot, 'web-service.json'), JSON.stringify({ pid: process.pid }))
    await writeFile(
      markerPath,
      JSON.stringify({
        schemaVersion: 1,
        configRoot,
        preservedConfigRoot,
        stagingConfigRoot,
        rollbackDataRoot
      })
    )

    await expect(
      runRollbackToV073({ configRoot, output: rollbackDataRoot, confirm: true })
    ).rejects.toThrow('Open Science is still running')

    await expect(stat(configRoot)).resolves.toBeDefined()
    await expect(stat(stagingConfigRoot)).resolves.toBeDefined()
    await expect(stat(preservedConfigRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(markerPath)).resolves.toBeDefined()
  })
})
