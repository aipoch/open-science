import { NotebookKernelExecutor } from './kernel-executor'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { analyzeNotebookSourceFileAccess } from '@aipoch/notebook-analysis'
import { macosLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/macos-isolation'
import { linuxLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/linux-isolation'
import { ProjectFolderStagedFiles } from '../project-folders/staged-files'
import { ProjectFolderNotebookExecution } from './project-folder-execution'
import type {
  NotebookSessionExecutionRequest,
  NotebookSessionExecutionResult
} from './session-aggregate'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
const result = (cwd: string): NotebookSessionExecutionResult => ({
  status: 'completed',
  cwdAfter: cwd,
  stdout: '',
  stderr: '',
  traceback: '',
  outputs: [],
  kernelDispatched: true,
  projectFolderStageReleased: true
})

async function fixture(): Promise<{
  folder: string
  dataRoot: string
  request: NotebookSessionExecutionRequest
  files: ProjectFolderStagedFiles
  execute: ProjectFolderNotebookExecution
  approve: ReturnType<typeof vi.fn>
}> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-notebook-flow-')))
  const folder = join(root, 'research')
  const storage = join(root, 'managed')
  const dataRoot = join(storage, 'notebooks', 'project-1', 'session-1', 'data')
  await mkdir(folder)
  await mkdir(dataRoot, { recursive: true })
  await writeFile(join(folder, 'raw.csv'), 'a,b\n1,2\n')
  const approve = vi.fn(async (): Promise<boolean> => true)
  const files = new ProjectFolderStagedFiles({
    storageRoot: storage,
    approve,
    authorizeCreatedFile: async () => true
  })
  return {
    folder,
    dataRoot,
    files,
    approve,
    request: {
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: 'run-1',
      language: 'python',
      code: 'text = open("raw.csv").read()\nopen("result.csv", "w").write(text)',
      cwd: dataRoot,
      dataRoot,
      notebookSessionRoot: join(dataRoot, '..'),
      runtimeRoot: join(storage, 'runtime')
    },
    execute: new ProjectFolderNotebookExecution({
      files,
      getFolder: async () => folder,
      analyze: analyzeNotebookSourceFileAccess
    })
  }
}

it('uses the Project cwd directly and retains independent approval for a precise existing-file edit', async () => {
  const h = await fixture()
  const completed = await h.execute.execute(h.request, async (prepared) => {
    expect(prepared).toMatchObject({
      projectFolderRoot: h.folder,
      observationMode: 'declared-paths'
    })
    expect(prepared.cwd.startsWith(h.dataRoot)).toBe(true)
    expect(prepared.cwd).not.toBe(h.folder)
    await writeFile(join(prepared.cwd, 'result.csv'), await readFile(join(prepared.cwd, 'raw.csv')))
    return result(h.dataRoot)
  })
  expect(completed.projectFolderChanges).toMatchObject([
    { operation: 'create', state: 'applied', requiresConfirmation: false }
  ])
  expect(completed.projectFolderInputs).toMatchObject([
    { relativePath: 'raw.csv', sizeBytes: 8, frozen: false }
  ])
  expect(h.approve).not.toHaveBeenCalled()
  await expect(readFile(join(h.folder, 'result.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
  h.approve.mockResolvedValueOnce(false)
  const rejected = await h.execute.execute(
    { ...h.request, runId: 'run-2', code: 'open("raw.csv", "w").write("candidate")' },
    async (prepared) => {
      await writeFile(join(prepared.cwd, 'raw.csv'), 'candidate')
      return result(prepared.cwd)
    }
  )
  expect(rejected.projectFolderChanges).toMatchObject([
    { operation: 'replace', state: 'rejected', requiresConfirmation: true }
  ])
  await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
})

it('reviews and undoes a file replacement from a project subdirectory', async () => {
  const h = await fixture()
  const subdir = join(h.folder, 'samples', 'batch')
  const target = join(subdir, 'raw.csv')
  const relativePath = join('samples', 'batch', 'raw.csv')
  await mkdir(subdir, { recursive: true })
  await writeFile(target, 'original nested data')
  const edit = (runId: string): Promise<NotebookSessionExecutionResult> =>
    h.execute.execute(
      { ...h.request, cwd: subdir, runId, code: 'open("raw.csv", "w").write("candidate")' },
      async (prepared) => {
        expect(prepared.projectFolderStageRoot).toBeDefined()
        expect(prepared.cwd).toBe(join(prepared.projectFolderStageRoot!, 'samples', 'batch'))
        expect(prepared.projectFolderReturnCwd).toBe(subdir)
        expect(prepared.unfrozenInputPaths).toEqual(['data/samples/batch/raw.csv'])
        const stagedTarget = join(prepared.cwd, 'raw.csv')
        await expect(readFile(stagedTarget, 'utf8')).resolves.toBe('original nested data')
        await writeFile(stagedTarget, 'candidate')
        await expect(readFile(target, 'utf8')).resolves.toBe('original nested data')
        return result(subdir)
      }
    )

  h.approve.mockResolvedValueOnce(false)
  expect((await edit('nested-rejected')).projectFolderChanges).toMatchObject([
    { relativePath, operation: 'replace', requiresConfirmation: true, state: 'rejected' }
  ])
  await expect(readFile(target, 'utf8')).resolves.toBe('original nested data')

  const applied = await edit('nested-approved')
  expect(applied.projectFolderInputs).toMatchObject([{ relativePath: 'samples/batch/raw.csv' }])
  expect(applied.projectFolderChanges).toMatchObject([
    { relativePath, operation: 'replace', requiresConfirmation: true, state: 'applied' }
  ])
  await expect(readFile(target, 'utf8')).resolves.toBe('candidate')
  await h.files.revert(
    { projectId: 'project-1', sessionId: 'session-1' },
    applied.projectFolderChanges![0].id
  )
  await expect(readFile(target, 'utf8')).resolves.toBe('original nested data')
  await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
})

it('uses fresh per-run copies across approved and rejected edits and preserves created-file identity', async () => {
  const h = await fixture()
  const edit = (
    path: string,
    content: string,
    runId: string
  ): Promise<NotebookSessionExecutionResult> =>
    h.execute.execute(
      {
        ...h.request,
        runId,
        code: `open(${JSON.stringify(path)}, "w").write(${JSON.stringify(content)})`
      },
      async (prepared) => {
        await writeFile(join(prepared.cwd, path), content)
        return result(prepared.cwd)
      }
    )
  await edit('raw.csv', 'B', 'run-b')
  await edit('raw.csv', 'C', 'run-c')
  h.approve.mockResolvedValueOnce(false)
  await edit('raw.csv', 'D', 'run-d')
  await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('C')
  await h.execute.execute(
    { ...h.request, runId: 'reread', code: 'open("raw.csv").read()' },
    async (prepared) => {
      await expect(readFile(join(prepared.cwd, 'raw.csv'), 'utf8')).resolves.toBe('C')
      return result(prepared.cwd)
    }
  )
  h.approve.mockClear()
  const created = await edit('new.txt', 'first', 'created-first')
  const replaced = await edit('new.txt', 'second', 'created-second')
  expect(created.projectFolderChanges?.[0].requiresConfirmation).toBe(false)
  expect(replaced.projectFolderChanges?.[0].requiresConfirmation).toBe(false)
  expect(h.approve).not.toHaveBeenCalled()
})

it('preserves completed Notebook results when a reviewed file changes before publication', async () => {
  const h = await fixture()
  const original = join(h.folder, 'raw.csv')
  h.approve.mockImplementationOnce(async () => {
    await writeFile(original, 'saved user edit')
    return true
  })
  const completed = await h.execute.execute(
    { ...h.request, code: 'open("raw.csv", "w").write("candidate")' },
    async (prepared) => {
      await writeFile(join(prepared.cwd, 'raw.csv'), 'candidate')
      return {
        ...result(prepared.cwd),
        stdout: 'completed scientific analysis',
        stderr: 'kernel warning',
        outputs: [{ type: 'stream', name: 'stdout', text: 'completed scientific analysis' }]
      }
    }
  )
  expect(completed).toMatchObject({
    status: 'completed',
    stdout: 'completed scientific analysis',
    stderr:
      'kernel warning\nCould not change raw.csv because the file changed on disk. Review the latest file or try a different name.',
    projectFolderChanges: [],
    outputs: [
      { type: 'stream', name: 'stdout', text: 'completed scientific analysis' },
      { type: 'stream', name: 'stderr', text: expect.stringContaining('Could not change raw.csv') }
    ]
  })
  await expect(readFile(original, 'utf8')).resolves.toBe('saved user edit')
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
})

it('prepares only existing source parents and releases successful, rejected and failed run copies', async () => {
  const h = await fixture()
  await mkdir(join(h.folder, 'results'))
  await h.execute.execute(
    {
      ...h.request,
      runId: 'nested-output',
      code: 'open("results/report.csv", "w").write("report")'
    },
    async (prepared) => {
      await writeFile(join(prepared.cwd, 'results/report.csv'), 'report')
      return result(prepared.cwd)
    }
  )
  await expect(readFile(join(h.folder, 'results/report.csv'), 'utf8')).resolves.toBe('report')
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
  await h.execute.execute(
    { ...h.request, runId: 'failed-output', code: 'open("raw.csv", "w").write("failed")' },
    async (prepared) => ({ ...result(prepared.cwd), status: 'failed' })
  )
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
  h.approve.mockResolvedValueOnce(false)
  await h.execute.execute(
    { ...h.request, runId: 'rejected-output', code: 'open("raw.csv", "w").write("rejected")' },
    async (prepared) => {
      await writeFile(join(prepared.cwd, 'raw.csv'), 'rejected')
      return result(prepared.cwd)
    }
  )
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
  await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
  await h.execute.execute(
    {
      ...h.request,
      runId: 'missing-parent',
      code: 'open("absent/report.csv", "w").write("report")'
    },
    async (prepared) => {
      await expect(
        writeFile(join(prepared.cwd, 'absent/report.csv'), 'report')
      ).rejects.toMatchObject({ code: 'ENOENT' })
      return { ...result(prepared.cwd), status: 'failed' }
    }
  )
  await expect(readdir(h.folder)).resolves.toEqual(['raw.csv', 'results'])
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
})

it('never falls back to direct overwrite when selected independent staging fails', async () => {
  const h = await fixture()
  vi.spyOn(h.files, 'stage').mockRejectedValueOnce(new Error('Independent copy failed'))
  const invoke = vi.fn(async () => result(h.dataRoot))
  await expect(
    h.execute.execute({ ...h.request, code: 'open("raw.csv", "w").write("candidate")' }, invoke)
  ).rejects.toThrow('Independent copy failed')
  expect(invoke).not.toHaveBeenCalled()
  await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
})

it('rejects an unsupported precise target in a project subdirectory before dispatch', async () => {
  const h = await fixture()
  const subdir = join(h.folder, 'source')
  await mkdir(join(subdir, 'directory'), { recursive: true })
  const invoke = vi.fn(async () => result(h.dataRoot))
  await expect(
    h.execute.execute(
      { ...h.request, cwd: subdir, code: 'open("directory", "w").write("candidate")' },
      invoke
    )
  ).rejects.toMatchObject({ reason: 'unsupported-path' })
  expect(invoke).not.toHaveBeenCalled()
})

it('keeps dynamic execution available and retains managed-only behavior', async () => {
  const h = await fixture()
  const invoke = vi.fn<
    (request: NotebookSessionExecutionRequest) => Promise<NotebookSessionExecutionResult>
  >(async () => result(h.dataRoot))
  await h.execute.execute(
    { ...h.request, code: 'path = input()\nopen(path, "w").write("candidate")' },
    invoke
  )
  expect(invoke).toHaveBeenCalledOnce()
  expect(invoke.mock.calls[0][0].cwd).toBe(h.folder)
  invoke.mockClear()
  const managed = new ProjectFolderNotebookExecution({
    files: h.files,
    getFolder: async () => undefined,
    analyze: analyzeNotebookSourceFileAccess
  })
  await managed.execute(h.request, invoke)
  expect(invoke).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenCalledWith(h.request)
})

it.skipIf(
  process.env.RUN_PROJECT_FOLDER_NATIVE !== '1' || !['darwin', 'linux'].includes(process.platform)
)(
  'runs real Python relative reads and direct outputs in the Project folder with existing protection',
  async () => {
    const h = await fixture()
    const python = '/usr/bin/python3'
    const launch = process.platform === 'darwin' ? macosLaunch : linuxLaunch
    const code =
      'text = open("raw.csv").read()\nopen("raw.csv", "w").write(text.replace("1", "9"))\nopen("result.csv", "w").write(text)'
    const completed = await h.execute.execute({ ...h.request, code }, async (prepared) => {
      const wrapped = await launch({
        command: `${python} -c '${prepared.code.replaceAll("'", "'\"'\"'")}'`,
        shell: '/bin/sh',
        cwd: prepared.cwd,
        gatewayPort: 3128,
        gatewayCredentials: { username: 'fixture', password: 'fixture' },
        env: { PATH: '/usr/bin:/bin' },
        filesystem: {
          restrictFolders: true,
          privateRoot: root!,
          readOnlyRoots: [h.folder, '/usr', '/bin'],
          readWriteRoots: [h.folder, h.dataRoot],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      try {
        const child = await promisify(execFile)(wrapped.argv[0], wrapped.argv.slice(1), {
          cwd: prepared.cwd,
          env: wrapped.env,
          timeout: 20_000
        })
        expect(child.stdout).toBe('')
      } finally {
        if ('release' in wrapped) await wrapped.release()
      }
      await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n9,2\n')
      return result(prepared.cwd)
    })
    await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n9,2\n')
    await expect(readFile(join(h.folder, 'result.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
    expect(h.approve).not.toHaveBeenCalled()
    expect(completed.projectFolderChanges).toBeUndefined()
  },
  30_000
)

it.skipIf(process.env.RUN_PROJECT_FOLDER_NATIVE !== '1' || process.platform === 'win32')(
  'uses explicit generated paths with real Python and REPL while retaining project inputs and persistent subdirectory cwd',
  async () => {
    const h = await fixture()
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js')
    })
    const subdir = join(h.folder, 'source')
    await mkdir(subdir)
    await writeFile(join(subdir, 'child.csv'), 'subdirectory input')
    await writeFile(join(h.folder, 'result.csv'), 'old root input')
    try {
      for (const kind of ['python', 'repl'] as const) {
        const outputRoot = join(h.folder, 'notebooks', 'project-1', `session-${kind}`, 'data')
        await mkdir(outputRoot, { recursive: true })
        const pythonCode = [
          'import os',
          'from pathlib import Path',
          'output = Path(os.environ["OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR"])',
          'text = Path("raw.csv").read_text()',
          '(output / "result.csv").write_text(text)',
          'os.chdir("source")'
        ].join('\n')
        const replCode = [
          'const fs = require("node:fs")',
          'const path = require("node:path")',
          'const output = process.env.OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR',
          'fs.writeFileSync(path.join(output, "result.csv"), fs.readFileSync("raw.csv"))',
          'process.chdir("source")'
        ].join(';')
        const request: NotebookSessionExecutionRequest = {
          ...h.request,
          outputRoot,
          runId: `explicit-${kind}-1`,
          code: kind === 'python' ? pythonCode : replCode,
          ...(kind === 'repl' ? { kind } : { resolvedInterpreter: { command: '/usr/bin/python3' } })
        }
        const first = await h.execute.execute(request, (prepared) => executor.execute(prepared))
        expect(first.status, JSON.stringify(first)).toBe('completed')
        expect(first.cwdAfter).toBe(subdir)
        const second = await h.execute.execute(
          {
            ...request,
            runId: `explicit-${kind}-2`,
            cwd: first.cwdAfter,
            code:
              kind === 'python'
                ? '(output / "combined.txt").write_text((output / "result.csv").read_text() + Path("child.csv").read_text())'
                : 'fs.writeFileSync(path.join(output, "combined.txt"), fs.readFileSync(path.join(output, "result.csv"), "utf8") + fs.readFileSync("child.csv", "utf8"))'
          },
          (prepared) => executor.execute(prepared)
        )
        expect(second.status, JSON.stringify(second)).toBe('completed')
        expect(second.cwdAfter).toBe(subdir)
        await expect(readFile(join(outputRoot, 'combined.txt'), 'utf8')).resolves.toBe(
          'a,b\n1,2\nsubdirectory input'
        )
        if (kind === 'python') {
          h.approve.mockResolvedValueOnce(false)
          const third = await h.execute.execute(
            {
              ...request,
              runId: 'replace-nested-3',
              cwd: second.cwdAfter,
              code: 'open("child.csv", "w").write("candidate")'
            },
            (prepared) => executor.execute(prepared)
          )
          expect(third.status, JSON.stringify(third)).toBe('completed')
          expect(third.cwdAfter).toBe(subdir)
          expect(third.projectFolderChanges).toMatchObject([
            {
              relativePath: join('source', 'child.csv'),
              state: 'rejected',
              requiresConfirmation: true
            }
          ])
          await expect(readFile(join(subdir, 'child.csv'), 'utf8')).resolves.toBe(
            'subdirectory input'
          )
        }
      }
      await expect(readFile(join(h.folder, 'result.csv'), 'utf8')).resolves.toBe('old root input')
      await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
    } finally {
      expect((await executor.shutdown()).reaped).toBe(true)
    }
  },
  30_000
)

it.skipIf(
  process.env.RUN_PROJECT_FOLDER_NATIVE !== '1' || !['darwin', 'linux'].includes(process.platform)
)(
  'leaves and releases a real persistent Python kernel preparation before the next cell',
  async () => {
    const h = await fixture()
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py')
    })
    const execute = (code: string, runId: string): Promise<NotebookSessionExecutionResult> =>
      h.execute.execute({ ...h.request, code, runId }, (prepared) =>
        executor.execute({
          ...prepared,
          resolvedInterpreter: { command: '/usr/bin/python3', args: ['-X', 'utf8'] }
        })
      )
    try {
      const first = await execute('open("raw.csv", "w").write("B")', 'persistent-first')
      expect(first.status, JSON.stringify(first)).toBe('completed')
      await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
      expect((await execute('open("raw.csv", "w").write("C")', 'persistent-second')).status).toBe(
        'completed'
      )
      await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
      await expect(readFile(join(h.folder, 'raw.csv'), 'utf8')).resolves.toBe('C')
    } finally {
      expect((await executor.shutdown()).reaped).toBe(true)
    }
  },
  30_000
)

it('defers cleanup until both candidate consumption and exact-tree reaping finish', async () => {
  const h = await fixture()
  let afterReap: (() => Promise<void>) | undefined
  await h.execute.execute(h.request, async (prepared) => {
    afterReap = prepared.onProjectFolderStageReaped
    await writeFile(join(prepared.cwd, 'result.csv'), 'candidate')
    // A matching tree teardown may finish before candidate capture. It cannot remove input yet.
    await afterReap!()
    await expect(readFile(join(prepared.cwd, 'result.csv'), 'utf8')).resolves.toBe('candidate')
    return { ...result(prepared.cwd), projectFolderStageReleased: false }
  })
  await expect(readFile(join(h.folder, 'result.csv'), 'utf8')).resolves.toBe('candidate')
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])

  await h.execute.execute(h.request, async (prepared) => {
    afterReap = prepared.onProjectFolderStageReaped
    await writeFile(join(prepared.cwd, 'result.csv'), 'next')
    return { ...result(prepared.cwd), projectFolderStageReleased: false }
  })
  expect(await readdir(join(h.dataRoot, '.project-preparations'))).toHaveLength(1)
  await afterReap!()
  await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
})

it.skipIf(
  process.env.RUN_PROJECT_FOLDER_NATIVE !== '1' || !['darwin', 'linux'].includes(process.platform)
)(
  'retains a preparation used by a live Python child until its exact owned tree reaps',
  async () => {
    const h = await fixture()
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py')
    })
    const execution = new ProjectFolderNotebookExecution({
      files: h.files,
      getFolder: async () => h.folder,
      // Model a library launching an asynchronous helper inside a declared single-file operation.
      analyze: () => analyzeNotebookSourceFileAccess('python', 'open("raw.csv", "w").write("B")')
    })
    try {
      const completed = await execution.execute(
        {
          ...h.request,
          code: [
            'import subprocess, sys',
            `subprocess.Popen([sys.executable, "-c", ${JSON.stringify("import time; time.sleep(0.3); open('late.txt', 'w').write('alive'); time.sleep(30)")}])`,
            'open("raw.csv", "w").write("B")'
          ].join('\n')
        },
        (prepared) =>
          executor.execute({
            ...prepared,
            resolvedInterpreter: { command: '/usr/bin/python3', args: ['-X', 'utf8'] }
          })
      )
      expect(completed.status, JSON.stringify(completed)).toBe('completed')
      const preparations = await readdir(join(h.dataRoot, '.project-preparations'))
      expect(preparations).toHaveLength(1)
      await vi.waitFor(
        async () => {
          await expect(
            readFile(
              join(h.dataRoot, '.project-preparations', preparations[0], 'data', 'late.txt'),
              'utf8'
            )
          ).resolves.toBe('alive')
        },
        { timeout: 5000 }
      )
      expect((await executor.shutdown()).reaped).toBe(true)
      await expect(readdir(join(h.dataRoot, '.project-preparations'))).resolves.toEqual([])
    } finally {
      await executor.shutdown()
    }
  },
  30_000
)
