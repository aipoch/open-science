import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import {
  markProjectRecordDetached,
  initializeProjectRecordStorage,
  registerProjectRecordStorage
} from '../projects/record-storage'
import { createFrameNotebookLane, createRootNotebookLane } from './lane-identity'
import { NotebookRunRepository, getNotebookSessionRoot } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookKernelExecutor } from './kernel-executor'
import { readNativeEvidence } from '../artifacts/execution-evidence-log'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

configureTestRuntimeMetadata()
const roots: string[] = []
const services: NotebookRuntimeService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async (): Promise<{
  root: string
  storageRoot: string
  folder: string
  records: string
}> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-project-records-')))
  roots.push(root)
  const storageRoot = join(root, 'managed')
  const folder = join(root, 'research')
  await mkdir(folder)
  await initializeProjectRecordStorage(storageRoot, folder, {
    format: 'open-science-project',
    version: 1,
    projectId: 'project',
    name: 'Research',
    createdAt: 1
  })
  return { root, folder, storageRoot, records: join(folder, '.open-science') }
}
const run = (kernelKind: NotebookRunRecord['kernelKind'], id: string): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  source: 'agent',
  kernelKind,
  script: `print(${JSON.stringify(id)})`,
  status: 'completed',
  startedAt: 1,
  text: { stdout: id, stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

describe('project-owned Notebook records', () => {
  it('does not recover terminal facts through a linked outbox', async () => {
    const { root, storageRoot, records, folder } = await fixture()
    const repository = new NotebookRunRepository(storageRoot)
    await repository.loadOrCreate({
      projectId: 'project',
      sessionId: 'session',
      workspaceCwd: folder,
      lane: createRootNotebookLane('project', 'session', 'root-frame')
    })
    const outside = join(root, 'outside-outbox')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.json'), '{"keep":true}')
    await symlink(
      outside,
      join(records, 'notebooks', 'project', 'session', '.run-terminal-outbox'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(repository.recoverAllRunLifecycles()).rejects.toThrow('links')
    expect(await readFile(join(outside, 'keep.json'), 'utf8')).toBe('{"keep":true}')
  })
  it('rejects linked record ancestors instead of reading or writing outside the Project', async () => {
    const { root, storageRoot, records, folder } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(join(records, 'notebooks'))
    await symlink(
      outside,
      join(records, 'notebooks', 'project'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const repository = new NotebookRunRepository(storageRoot)
    await expect(
      repository.loadOrCreate({
        projectId: 'project',
        sessionId: 'session',
        workspaceCwd: folder,
        lane: createRootNotebookLane('project', 'session', 'root-frame')
      })
    ).rejects.toThrow('links')
    await expect(repository.findExisting('project', 'session')).rejects.toThrow('links')
    expect(await readdir(outside)).toEqual([])
  })
  it('persists every kernel and frame lane with portable identities, while execution remains managed', async () => {
    const { storageRoot, folder, records, root } = await fixture()
    const repository = new NotebookRunRepository(storageRoot)
    const rootLane = createRootNotebookLane('project', 'session', 'root-frame')
    const frameLane = createFrameNotebookLane('project', 'session', 'child-frame')
    for (const lane of [rootLane, frameLane]) {
      const document = await repository.loadOrCreate({
        projectId: 'project',
        sessionId: 'session',
        workspaceCwd: folder,
        lane
      })
      expect(document.notebookSessionRoot).toBe(
        getNotebookSessionRoot(storageRoot, 'project', 'session', lane)
      )
      expect(document.kernel.runtimeRoot).toBe(join(storageRoot, 'runtime'))
      for (const kind of ['python', 'r', 'repl', 'bash'] as const) {
        await repository.appendRun({
          projectId: 'project',
          sessionId: 'session',
          lane,
          run: {
            ...run(kind, `${kind}-${lane === rootLane ? 'root' : 'child'}`),
            cwdBefore: folder,
            // Exercise immutable .run-records payloads, not just inline manifests.
            text: { stdout: 'x'.repeat(70_000), stderr: '', traceback: '', plain: [] }
          }
        })
      }
      const durableDirectory = dirname(repository.runJsonPath('project', 'session', lane))
      expect(durableDirectory.startsWith(records)).toBe(true)
      const saved = JSON.parse(await readFile(join(durableDirectory, 'run.json'), 'utf8'))
      expect(saved.workspaceCwd).toBe('$PROJECT/')
      expect(saved.notebookSessionRoot).toMatch(/^\$DATA\/notebooks\//)
      expect(saved.runs.every((entry: { storage: string }) => entry.storage === 'file')).toBe(true)
      expect(await readdir(join(durableDirectory, '.run-records'))).toHaveLength(4)
      await expect(readFile(join(document.notebookSessionRoot, 'run.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(await readdir(durableDirectory)).not.toContain('cache')
    }
    const moved = join(root, 'moved-research')
    await rename(folder, moved)
    await expect(repository.findExisting('project', 'session')).rejects.toThrow(
      'Notebook project records are unavailable'
    )
    await registerProjectRecordStorage(storageRoot, moved, 'project')
    const reopened = new NotebookRunRepository(storageRoot)
    const documents = await reopened.readSessionDocuments('project', 'session')
    expect(documents).toHaveLength(2)
    expect(documents.flatMap((document) => document.runs)).toHaveLength(8)
    expect(documents.every((document) => document.workspaceCwd === moved)).toBe(true)
    expect(
      documents.flatMap((document) => document.runs).every((entry) => entry.cwdBefore === moved)
    ).toBe(true)
    expect(await reopened.listProjectSessionIds('project')).toEqual(['session'])
    expect(await reopened.recoverAllRunLifecycles()).toEqual([])
    expect(reopened.fileEvidenceLocation('project', 'session', frameLane)).toEqual({
      storageRoot: join(moved, '.open-science'),
      root: join(moved, '.open-science/execution-file-evidence/project/session/frames/child-frame'),
      storageKeyPrefix: 'execution-file-evidence/project/session/frames/child-frame'
    })
  })

  it('does not replace missing referenced records with an empty Notebook', async () => {
    const { storageRoot, folder } = await fixture()
    const repository = new NotebookRunRepository(storageRoot)
    const lane = createRootNotebookLane('project', 'session', 'root-frame')
    const request = { projectId: 'project', sessionId: 'session', workspaceCwd: folder, lane }
    await repository.loadOrCreate(request)
    await repository.appendRun({
      ...request,
      run: {
        ...run('python', 'large'),
        text: { stdout: 'x'.repeat(70_000), stderr: '', traceback: '', plain: [] }
      }
    })
    const path = repository.runJsonPath('project', 'session')
    const manifest = await readFile(path, 'utf8')
    await rm(join(dirname(path), '.run-records'), { recursive: true })
    await expect(new NotebookRunRepository(storageRoot).loadOrCreate(request)).rejects.toThrow(
      'Notebook document is corrupt'
    )
    expect(await readFile(path, 'utf8')).toBe(manifest)
  })

  it('recovers durable terminal facts for root and frame runs after restarting', async () => {
    const { storageRoot, folder } = await fixture()
    const repository = new NotebookRunRepository(storageRoot)
    for (const lane of [
      createRootNotebookLane('project', 'session', 'root-frame'),
      createFrameNotebookLane('project', 'session', 'child')
    ]) {
      const request = { projectId: 'project', sessionId: 'session', workspaceCwd: folder, lane }
      await repository.loadOrCreate(request)
      const running = {
        ...run('bash', 'recover'),
        status: 'running' as const,
        executionMode: 'background' as const
      }
      await repository.appendRun({ ...request, run: running })
      const outbox = join(
        dirname(repository.runJsonPath('project', 'session', lane)),
        '.run-terminal-outbox'
      )
      await mkdir(outbox)
      await writeFile(
        join(outbox, 'recover.json'),
        JSON.stringify({
          version: 1,
          projectId: 'project',
          sessionId: 'session',
          expectedStatus: 'running',
          run: {
            ...running,
            status: 'completed',
            cwdBefore: '$PROJECT/',
            text: { ...running.text, stdout: 'recovered' }
          }
        })
      )
    }
    const restarted = new NotebookRunRepository(storageRoot)
    expect(await restarted.recoverAllRunLifecycles()).toHaveLength(2)
    expect(
      (await restarted.readSessionRuns('project', 'session')).every(
        (entry) => entry.status === 'completed' && entry.cwdBefore === folder
      )
    ).toBe(true)
    await markProjectRecordDetached(storageRoot, 'project')
    expect(await new NotebookRunRepository(storageRoot).recoverAllRunLifecycles()).toEqual([])
    expect(await restarted.readSessionRuns('project', 'session')).toHaveLength(2)
  })

  it.skipIf(process.env.RUN_PROJECT_RECORD_NATIVE !== '1')(
    'runs real Python in the project folder and reads its evidence after move and restart',
    async () => {
      const { storageRoot, folder, root } = await fixture()
      let currentFolder = folder
      const python = process.env.OPEN_SCIENCE_TEST_PY_ENV ?? '/usr/bin/python3'
      const request = { sessionId: 'python', workspaceCwd: join(storageRoot, 'provider') }
      const makeService = (): NotebookRuntimeService => {
        const service = new NotebookRuntimeService({
          configRoot: storageRoot,
          dataRoot: storageRoot,
          projectId: 'project',
          platform: process.platform === 'darwin' ? 'linux' : process.platform,
          assertProjectFolderHealthy: async () => currentFolder,
          discoverRuntimes: async (language) =>
            language === 'python'
              ? [
                  {
                    language: 'python',
                    provenance: 'user-own',
                    envId: python,
                    interpreterPath: python,
                    label: 'Python',
                    version: 'system',
                    runnable: true
                  }
                ]
              : [],
          notebookRuntimeSettings: {
            getSnapshot: async (language) => ({
              language,
              runtimeEnablement: { enabled: { [python]: true }, installAuthorized: {} },
              manualInterpreters: [],
              packageMirror: {}
            })
          },
          executorFactory: () =>
            new NotebookKernelExecutor({
              pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py')
            })
        })
        services.push(service)
        return service
      }
      const first = makeService()
      await first.bindRuntime({ ...request, language: 'python', runtimeId: python })
      const result = await first.execute({
        ...request,
        code: 'open("result.csv", "w").write("native-python")\nprint("python-evidence")',
        language: 'python'
      })
      expect(result.status, JSON.stringify(result)).toBe('completed')
      expect(await readFile(join(folder, 'result.csv'), 'utf8')).toBe('native-python')
      const saved = await new NotebookRunRepository(storageRoot).findExisting('project', 'python')
      expect(saved?.runs[0].text.stdout).toContain('python-evidence')
      expect(saved?.runs[0].fileEvidence?.storageKey).toMatch(
        /^execution-file-evidence\/project\/python\//
      )
      const evidence = saved!.runs[0].fileEvidence!
      const readEvidence = (projectFolder: string): Promise<Buffer> =>
        readNativeEvidence(
          join(projectFolder, '.open-science'),
          evidence.storageKey!,
          evidence.checksum!,
          64 * 1024 ** 2
        )
      expect((await readEvidence(folder)).toString()).toContain(result.runId)
      await first.dispose()
      currentFolder = join(root, 'renamed')
      await rename(folder, currentFolder)
      await registerProjectRecordStorage(storageRoot, currentFolder, 'project')
      const restarted = makeService()
      const restored = await restarted.state(request)
      expect(restored.runs[0].runId).toBe(result.runId)
      const continued = await restarted.execute({
        ...request,
        code: 'open("continued.csv", "w").write("after-restart")',
        language: 'python'
      })
      expect(continued.status, JSON.stringify(continued)).toBe('completed')
      expect(await readFile(join(currentFolder, 'continued.csv'), 'utf8')).toBe('after-restart')
      await restarted.deleteProjectFileEvidence('project')
      expect((await readEvidence(currentFolder)).toString()).toContain(result.runId)
    },
    60_000
  )

  it.skipIf(process.platform === 'win32')(
    'runs a real Shell with ordinary project outputs, reopens history, and keeps caches managed',
    async () => {
      const { storageRoot, folder, records } = await fixture()
      const makeService = (): NotebookRuntimeService => {
        const service = new NotebookRuntimeService({
          configRoot: storageRoot,
          dataRoot: storageRoot,
          projectId: 'project',
          platform: process.platform === 'darwin' ? 'linux' : process.platform,
          assertProjectFolderHealthy: async () => folder
        })
        services.push(service)
        return service
      }
      const request = { sessionId: 'shell', workspaceCwd: folder }
      const first = makeService()
      const result = await first.executeShell({
        ...request,
        command: "printf 'native-output' > result.txt; printf 'native-stdout'"
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('native-stdout')
      const state = await first.state(request)
      expect(state.runJsonPath).toBe(join(records, 'notebooks/project/shell/run.json'))
      expect(state.dataRoot).toBe(join(storageRoot, 'notebooks/project/shell/data'))
      expect(await readFile(join(folder, 'result.txt'), 'utf8')).toBe('native-output')
      expect(await readdir(dirname(state.runJsonPath))).not.toContain('cache')
      const persisted = JSON.parse(await readFile(state.runJsonPath, 'utf8'))
      expect(persisted.runs[0].frozenShellContext.cwd).toBe('$PROJECT/')
      await first.dispose()
      const restarted = makeService()
      const restored = await restarted.state(request)
      expect(restored.runs[0]).toMatchObject({
        kernelKind: 'bash',
        status: 'completed',
        text: { stdout: 'native-stdout' }
      })
      expect(restored.runJsonPath).toBe(state.runJsonPath)
      expect(
        (await restarted.executeShell({ ...request, command: "printf 'second' > continued.txt" }))
          .exitCode
      ).toBe(0)
      expect(await readFile(join(folder, 'continued.txt'), 'utf8')).toBe('second')
    },
    30_000
  )
})
