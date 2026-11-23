import { initDataRoot } from '../storage-root'
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
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { healthyNotebookMemoryPolicy } from '../notebook/memory-policy.test-support'
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
  initDataRoot(root)
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
      runtimeBindings: Object.fromEntries(
        (['python', 'r'] as const).map((language) => [
          language,
          {
            language,
            runtimeId: `${workspace}/${language}`,
            interpreterPath: `${workspace}/${language}`,
            source: 'managed',
            provenance: 'agent-created',
            label: `Source ${language}`,
            status: 'active'
          }
        ])
      ),
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
      expect.soft(document.runtimeBindings).toBeUndefined()
      expect(
        await new SessionRepository(configRoot).loadSession(imported.projectId, imported.sessionId)
      ).toMatchObject({
        packageOrigin: { sourceProjectId: 'project', sourceSessionId: 'session' },
        cwd: ''
      })

      const fork = await service.fork(imported)
      const [forkDocument] = await new NotebookRunRepository(storageRoot).readSessionDocuments(
        fork.projectId,
        fork.sessionId
      )
      expect.soft(forkDocument.runtimeBindings).toBeUndefined()
      expect(forkDocument.runs[0].script).toBe(script)
      const runtime = new NotebookRuntimeService({
        configRoot,
        dataRoot: storageRoot,
        projectId: fork.projectId,
        discoverRuntimes: async () => [],
        getAgentEnvironmentCreationEnabled: async () => false,
        memoryPolicy: healthyNotebookMemoryPolicy(),
        processSandbox: {
          wrap: async () => {
            throw new Error('Reading imported history must not start an interpreter')
          }
        }
      })
      try {
        const state = await runtime.state({ ...fork, workspaceCwd: storageRoot })
        expect(state.runtimeBindings.python).toBeUndefined()
        expect(state.runtimeBindings.r).toBeUndefined()
        expect(runtime.ownedResources()).toEqual([])
      } finally {
        await expect(runtime.dispose()).resolves.toEqual({ reaped: true })
      }

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
        expect(forwardedOrigin.sourceManifest).toEqual({
          ...origin.sourceManifest,
          requiredFeatures: ['ro-crate'],
          inventory: [
            ...origin.sourceManifest.inventory,
            expect.objectContaining({ path: 'ro-crate-metadata.json', kind: 'metadata' })
          ]
        })
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

it('imports a legacy Notebook run without kernelKind as a cold historical session', async () => {
  const archive = await archiveWithFiles([], {
    version: 1,
    projectId: 'project',
    sessionId: 'session',
    updatedAt: 2,
    workspaceCwd: '$DATA/notebooks/project/session',
    notebookSessionRoot: '$DATA/notebooks/project/session',
    dataRoot: '$DATA/notebooks/project/session/data',
    kernel: { runtimeRoot: '$DATA/runtime', pythonPath: '/source/runtime/python' },
    runs: [
      {
        runId: 'legacy-run',
        cellId: 'legacy-cell',
        source: 'agent',
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        script: "print('legacy')",
        text: { stdout: 'legacy\n', stderr: '', traceback: '', plain: ['legacy'] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    ]
  })
  const target = await createProvenanceTestFixture()
  const service = new SessionPackageService({
    storageRoot: target.storageRoot,
    configRoot: join(target.storageRoot, 'config'),
    getClient: async () => target.client
  })
  try {
    const imported = await service.importFrom(archive)
    const [document] = await new NotebookRunRepository(target.storageRoot).readSessionDocuments(
      imported.projectId,
      imported.sessionId
    )

    expect(document.runs[0]).toMatchObject({ kernelKind: 'python', script: "print('legacy')" })
    expect(document.kernel).toMatchObject({
      runtimeRoot: join(target.storageRoot, 'runtime'),
      lastKnownStatus: 'idle'
    })
    expect(document.kernel.pythonPath).toBeUndefined()
    expect(document.runs[0]?.status).toBe('completed')
    expect(
      await new SessionRepository(join(target.storageRoot, 'config')).loadSession(
        imported.projectId,
        imported.sessionId
      )
    ).toMatchObject({ packageOrigin: { sourceProjectId: 'project', sourceSessionId: 'session' } })
  } finally {
    await service.close()
    await target.dispose()
  }
})
