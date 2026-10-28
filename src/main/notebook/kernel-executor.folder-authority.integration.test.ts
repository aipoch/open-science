import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import type { NotebookExecutionResult } from './runtime-service'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'

vi.mock('./working-file-observer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./working-file-observer')>()
  return {
    ...actual,
    // These cases exercise native folder authority across real kernel restarts. Retain actual
    // file snapshots and evidence writes through the existing watcher-unavailable fallback.
    // Direct observer integration and the other kernel tests retain native watcher coverage.
    startWorkingFileObservation: (
      request: Parameters<typeof actual.startWorkingFileObservation>[0],
      dependencies: Parameters<typeof actual.startWorkingFileObservation>[1]
    ) =>
      actual.startWorkingFileObservation(request, {
        ...dependencies,
        watchDirectory: () => {
          throw Object.assign(new Error('Native watcher unavailable in this fixture.'), {
            code: 'ENOSYS'
          })
        }
      })
  }
})

// Match the interpreter selection used by the other kernel executor tests.
const python3 = [
  process.env.OPEN_SCIENCE_TEST_PY_ENV,
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3'
].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))

const baseRequest = (
  cwd: string
): {
  cwd: string
  notebookSessionRoot: string
  inputRoot: string
  dataRoot: string
  runtimeRoot: string
} => ({
  cwd,
  notebookSessionRoot: join(cwd, 'nb'),
  inputRoot: join(cwd, 'inputs'),
  dataRoot: join(cwd, 'nb', 'data'),
  runtimeRoot: join(cwd, 'runtime')
})

it
  .skipIf(
    !python3 ||
      process.platform === 'win32' ||
      (process.platform === 'linux' && process.env.VITEST_PORTABLE_CI === '1')
  )
  .each([
    { access: 'ro' as const, alias: false },
    { access: 'rw' as const, alias: false },
    { access: 'ro' as const, alias: true },
    { access: 'rw' as const, alias: true }
  ])(
  'keeps folder authority $access after chdir and kernel restart (alias=$alias)',
  async ({ access, alias }) => {
    const root = await mkdtemp(join(tmpdir(), 'os-kernel-folder-authority-'))
    const workspace = join(root, 'workspace')
    const granted = join(root, 'granted')
    const ungranted = join(root, 'ungranted.txt')
    const protectedFile = join(granted, 'protected.txt')
    const file = join(granted, 'data.txt')
    const request = { ...baseRequest(workspace), notebookSessionRoot: workspace }
    for (const directory of [
      workspace,
      granted,
      request.inputRoot,
      request.dataRoot,
      request.runtimeRoot
    ])
      await mkdir(directory, { recursive: true })
    await Promise.all([file, ungranted, protectedFile].map((path) => writeFile(path, 'original')))
    const destination = alias ? join(workspace, 'linked-folder') : granted
    if (alias) await symlink(granted, destination, 'dir')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve(
        import.meta.dirname,
        '../../../packages/notebook-network-sandbox/vendor'
      ),
      temporaryRoot: join(workspace, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getFolderRestrictionEnabled: async () => true,
      getGrantedLocalRoots: async () => [
        { id: 'folder', name: 'granted', path: realpathSync(granted), access }
      ],
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const executor = new NotebookKernelExecutor({
      processSandbox: owner,
      pythonLoopPath: resolve(import.meta.dirname, '../../../resources/notebook/python_loop.py')
    })
    const run = (code: string, cwd = workspace): Promise<NotebookExecutionResult> =>
      executor.execute({
        ...request,
        cwd,
        code,
        language: 'python',
        resolvedInterpreter: { command: python3! },
        protectedDirs: [protectedFile],
        sessionId: 'folder-session',
        projectId: 'folder-project'
      })
    try {
      expect(await run(`open('workspace.txt', 'w').write('workspace')`)).toMatchObject({
        status: 'completed'
      })
      const write = `open(${JSON.stringify(file)}, 'w').write('changed')`
      expect(await run(write)).toMatchObject({ status: access === 'rw' ? 'completed' : 'failed' })
      const moved = await run(`import os; os.chdir(${JSON.stringify(destination)})`)
      expect(moved, moved.traceback).toMatchObject({ status: 'completed' })
      expect(realpathSync(moved.cwdAfter!)).toBe(realpathSync(granted))
      for (const restarted of [false, true]) {
        if (restarted) await executor.restart()
        expect(await run(`print(open('data.txt').read())`, moved.cwdAfter)).toMatchObject({
          status: 'completed'
        })
        expect(await run(write, moved.cwdAfter)).toMatchObject({
          status: access === 'rw' ? 'completed' : 'failed'
        })
        for (const denied of [ungranted, protectedFile])
          expect(
            await run(`print(open(${JSON.stringify(denied)}).read())`, moved.cwdAfter)
          ).toMatchObject({ status: 'failed' })
        expect(
          await run(
            `open(${JSON.stringify(join(workspace, 'workspace.txt'))}, 'w').write('still writable')`,
            moved.cwdAfter
          )
        ).toMatchObject({ status: 'completed' })
      }
      // A reported filesystem-root cwd must never become a new grant on the next launch.
      const atRoot = await run(`import os; os.chdir('/')`, moved.cwdAfter)
      expect(atRoot).toMatchObject({ status: 'completed', cwdAfter: '/' })
      await executor.restart()
      expect(
        await run(`print(open(${JSON.stringify(ungranted)}).read())`, atRoot.cwdAfter)
      ).toMatchObject({ status: 'failed' })
      expect(await readFile(file, 'utf8')).toBe(access === 'rw' ? 'changed' : 'original')
      expect(await readFile(protectedFile, 'utf8')).toBe('original')
    } finally {
      await executor.shutdown()
      await owner.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

configureTestRuntimeMetadata()
