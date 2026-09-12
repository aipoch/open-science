import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { c as createTar } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { sha256 } from '../artifacts/provenance-canonical'
import { packageNativeTables } from './native-snapshot'
import { SessionPackageService } from './service'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { NotebookRunRepository } from '../notebook/repository'
import { SessionRepository } from '../session-persistence/repository'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// Original filenames are manifest metadata. Only fixed ASCII object names touch the fixture
// filesystem, so these admission tests also run on hosts that cannot create the invalid names.
const archiveWithFiles = async (
  filenames: string[],
  notebook?: Record<string, unknown>
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'science-package-portability-'))
  directories.push(root)
  const source = join(root, 'source')
  await mkdir(join(source, 'objects'), { recursive: true })
  const contents = [
    {
      path: 'session.json',
      kind: 'session',
      contents: JSON.stringify({
        version: 2,
        session: {
          id: 'session',
          projectId: 'project',
          title: 'Portable research',
          cwd: '',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      })
    },
    {
      path: 'records.json',
      kind: 'records',
      contents: JSON.stringify({
        schemaVersion: 1,
        tables: Object.fromEntries(packageNativeTables.map((name) => [name, []]))
      })
    },
    { path: 'README.md', kind: 'readme', contents: 'Portable research fixture' },
    ...filenames.map((filename) => ({
      path: `objects/${sha256(filename)}`,
      kind: 'file',
      contents: `Evidence for ${filename}`,
      storageKey: `notebooks/project/session/data/${filename}`
    })),
    ...(notebook
      ? [
          {
            path: `objects/${sha256('run.json')}`,
            kind: 'notebook',
            contents: JSON.stringify(notebook),
            storageKey: 'notebooks/project/session/run.json'
          }
        ]
      : [])
  ]
  for (const entry of contents) await writeFile(join(source, entry.path), entry.contents)
  const inventory = contents.map(({ contents: bytes, ...entry }) => ({
    ...entry,
    sizeBytes: Buffer.byteLength(bytes),
    checksum: sha256(bytes)
  }))
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      format: 'open-science-session',
      schemaVersion: 1,
      createdAt: 1,
      source: {
        projectId: 'project',
        sessionId: 'session',
        projectName: 'Research',
        title: 'Portable research'
      },
      inventory,
      excludedFiles: [],
      omissions: []
    })
  )
  const archive = join(root, 'research.science')
  await createTar({ cwd: source, file: archive, gzip: true, portable: true }, [
    'manifest.json',
    ...contents.map((entry) => entry.path)
  ])
  return archive
}

it.each(['COM¹.txt', 'com².csv', 'COM³', 'LPT¹.json', 'lpt²', 'LPT³.txt'])(
  'rejects a Windows device filename before accepting a portable package: %s',
  async (filename) => {
    const archive = await archiveWithFiles([filename])
    const getClient = vi.fn(async () => {
      throw new Error('Application database must not be reached')
    })
    const service = new SessionPackageService({ storageRoot: directories.at(-1)!, getClient })
    try {
      await expect(service.inspect(archive)).rejects.toThrow('non-portable storage path')
      expect(getClient).not.toHaveBeenCalled()
    } finally {
      await service.close()
    }
  }
)

it.each([
  ['Report.csv', 'report.csv'],
  ['café.csv', 'cafe\u0301.csv']
])('rejects names that collide across platform filesystems: %s / %s', async (first, second) => {
  const archive = await archiveWithFiles([first, second])
  const service = new SessionPackageService({
    storageRoot: directories.at(-1)!,
    getClient: async () => {
      throw new Error('Application database must not be reached')
    }
  })
  try {
    await expect(service.inspect(archive)).rejects.toThrow('colliding storage paths')
  } finally {
    await service.close()
  }
})

it('accepts Unicode filenames and ordinary names resembling device names', async () => {
  const filenames = ['研究数据.csv', 'café.csv', 'COM10.txt', 'COM¹-report.csv']
  const archive = await archiveWithFiles(filenames)
  const service = new SessionPackageService({
    storageRoot: directories.at(-1)!,
    getClient: async () => {
      throw new Error('Application database must not be reached')
    }
  })
  try {
    await expect(service.inspect(archive)).resolves.toMatchObject({ fileCount: filenames.length })
  } finally {
    await service.close()
  }
})

it.each([
  ['Windows drive', 'C:\\Users\\Researcher\\project'],
  ['Windows UNC', '\\\\lab\\share\\project'],
  ['POSIX', '/home/researcher/project']
])(
  'reopens managed Notebook paths while retaining %s environment text',
  async (platform, workspace) => {
    const filename = '研究数据.csv'
    const script = `# Original workspace: ${workspace}`
    const managedRoot = '$DATA/notebooks/project/session'
    const archive = await archiveWithFiles([filename], {
      version: 1,
      projectId: 'project',
      sessionId: 'session',
      updatedAt: 2,
      workspaceCwd: workspace,
      notebookSessionRoot: managedRoot,
      dataRoot: `${managedRoot}/data`,
      kernel: { runtimeRoot: '$DATA/runtime', pythonPath: `${workspace}/python` },
      runs: [
        {
          runId: 'run',
          cellId: 'cell',
          source: 'user',
          kernelKind: 'python',
          status: 'completed',
          startedAt: 1,
          endedAt: 2,
          script,
          cwdBefore: `${managedRoot}/data`,
          cwdAfter: `${managedRoot}/data`,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [
            {
              path: `${managedRoot}/data/${filename}`,
              relativePath: platform.startsWith('Windows')
                ? `data\\${filename}`
                : `data/${filename}`,
              kind: 'other',
              size: Buffer.byteLength(`Evidence for ${filename}`),
              mtimeMs: 1
            }
          ]
        }
      ]
    })
    const target = await createProvenanceTestFixture()
    const storageRoot = join(target.storageRoot, '研究 数据')
    const configRoot = join(target.storageRoot, '本地 设置')
    const service = new SessionPackageService({
      storageRoot,
      configRoot,
      getClient: async () => target.client
    })
    try {
      const imported = await service.importFrom(archive)
      const [document] = await new NotebookRunRepository(storageRoot).readSessionDocuments(
        imported.projectId,
        imported.sessionId
      )
      const dataRoot = join(
        storageRoot,
        'notebooks',
        imported.projectId,
        imported.sessionId,
        'data'
      )
      const run = document.runs[0]
      expect(document.dataRoot).toBe(dataRoot)
      expect(run.workingFiles[0].path).toBe(join(dataRoot, filename))
      expect(await readFile(run.workingFiles[0].path, 'utf8')).toBe(`Evidence for ${filename}`)
      expect(run.cwdBefore).toBe(dataRoot)
      expect(run.cwdAfter).toBe(dataRoot)
      expect(run.script).toBe(script)
      expect(document.kernel.pythonPath).toBeUndefined()
      expect(
        await new SessionRepository(configRoot).loadSession(imported.projectId, imported.sessionId)
      ).toMatchObject({
        packageOrigin: { sourceProjectId: 'project', sourceSessionId: 'session' },
        cwd: ''
      })

      const origin = await service.readOrigin(imported)
      const forwarded = join(target.storageRoot, '再次 导出.science')
      await service.exportTo(imported, forwarded)
      const next = await createProvenanceTestFixture()
      const receiver = new SessionPackageService({
        storageRoot: next.storageRoot,
        getClient: async () => next.client
      })
      try {
        const received = await receiver.importFrom(forwarded)
        expect(received.projectId).not.toBe(imported.projectId)
        expect(received.sessionId).not.toBe(imported.sessionId)
        const forwardedOrigin = await receiver.readOrigin(received)
        expect(forwardedOrigin.sourceManifest).toEqual(origin.sourceManifest)
        const [reopened] = await new NotebookRunRepository(next.storageRoot).readSessionDocuments(
          received.projectId,
          received.sessionId
        )
        const receivedRoot = join(
          next.storageRoot,
          'notebooks',
          received.projectId,
          received.sessionId,
          'data'
        )
        expect(reopened.dataRoot).toBe(receivedRoot)
        expect(reopened.runs[0]).toMatchObject({
          cwdBefore: receivedRoot,
          cwdAfter: receivedRoot,
          script,
          workingFiles: [{ path: join(receivedRoot, filename) }]
        })
        expect(await readFile(reopened.runs[0].workingFiles[0].path, 'utf8')).toBe(
          `Evidence for ${filename}`
        )
      } finally {
        await receiver.close()
        await next.dispose()
      }
    } finally {
      await service.close()
      await target.dispose()
    }
  }
)
