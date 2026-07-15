import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { NotebookPythonExecutor } from './python-executor'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-executor-'))
  return storageRoot
}

const hasPython3 = (): boolean => spawnSync('python3', ['--version']).status === 0

// Spawning python cold on a Windows CI runner (interpreter start + first imports like matplotlib) is
// well over the 5s vitest default, so the process-backed cases get generous headroom.
const PYTHON_TEST_TIMEOUT_MS = 30_000

afterEach(async () => {
  if (storageRoot) {
    // Retry the removal: on Windows a just-killed interpreter can briefly keep a handle on the temp
    // tree, so the first rmdir may fail with EBUSY before the OS releases it.
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    storageRoot = undefined
  }
})

describe('notebook Python executor', () => {
  it('returns a failed execution result when the Python executable is missing', async () => {
    const root = await createStorageRoot()
    const executor = new NotebookPythonExecutor('/definitely/missing/open-science-python')

    const result = await executor.execute({
      code: 'print(1)',
      cwd: root,
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      runtimeRoot: join(root, 'runtime')
    })

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('ENOENT')
  })

  const itWithPython = hasPython3() ? it : it.skip

  itWithPython(
    'blocks reading files inside a protected directory but allows others',
    async () => {
      const root = await createStorageRoot()
      const protectedDir = join(root, 'claude')
      const secret = join(protectedDir, 'skills', 'os-demo', 'SKILL.md')
      await mkdir(dirname(secret), { recursive: true })
      await writeFile(secret, 'secret skill body', 'utf8')
      const executor = new NotebookPythonExecutor('python3')

      const base = {
        cwd: root,
        notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
        dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
        runtimeRoot: join(root, 'runtime'),
        protectedDirs: [protectedDir]
      }

      try {
        const blocked = await executor.execute({
          ...base,
          code: `open(${JSON.stringify(secret)}).read()`
        })
        expect(blocked.status).toBe('failed')
        expect(blocked.traceback).toContain('PermissionError')

        // A file outside the protected directory still reads normally.
        const allowedFile = join(root, 'ok.txt')
        await writeFile(allowedFile, 'fine', 'utf8')
        const allowed = await executor.execute({
          ...base,
          code: `print(open(${JSON.stringify(allowedFile)}).read())`
        })
        expect(allowed).toMatchObject({ status: 'completed', stdout: 'fine\n' })
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'keeps Python variables across executions in one executor',
    async () => {
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')

      try {
        const first = await executor.execute({
          code: 'x = 41',
          cwd: root,
          notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
          dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
          runtimeRoot: join(root, 'runtime')
        })
        const second = await executor.execute({
          code: 'print(x + 1)',
          cwd: root,
          notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
          dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
          runtimeRoot: join(root, 'runtime')
        })

        expect(first.status).toBe('completed')
        expect(second).toMatchObject({
          status: 'completed',
          stdout: '42\n'
        })
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'echoes a trailing expression like Jupyter so a bare variable shows output',
    async () => {
      // Root-cause fix for the double host.mcp call: with a plain exec(), `result` on the last line
      // produced no output, so the agent re-ran the call in a second cell just to print it. Echoing
      // the trailing expression (repr) makes `result` visible in one cell, no explicit print needed.
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')

      const base = {
        cwd: root,
        notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
        dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
        runtimeRoot: join(root, 'runtime')
      }

      try {
        // Assignment then a bare expression: only the trailing expression echoes, as its repr.
        const echoed = await executor.execute({
          ...base,
          code: 'result = {"count": 0, "term": "肿瘤进展"}\nresult'
        })
        expect(echoed).toMatchObject({ status: 'completed' })
        expect(echoed.stdout).toBe("{'count': 0, 'term': '肿瘤进展'}\n")

        // A cell ending in a statement (assignment) echoes nothing.
        const silent = await executor.execute({ ...base, code: 'y = 5' })
        expect(silent).toMatchObject({ status: 'completed', stdout: '' })

        // A trailing expression that evaluates to None echoes nothing (matches Jupyter).
        const none = await executor.execute({ ...base, code: 'print("hi")\nNone' })
        expect(none).toMatchObject({ status: 'completed', stdout: 'hi\n' })
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'suppresses matplotlib artist reprs in the trailing-expression echo',
    async () => {
      // Headless Agg can't render a figure inline, so a matplotlib artist (or a list/tuple of them,
      // e.g. plt.plot(...) -> [Line2D]) at the end of a cell would echo a noisy object repr. Faking
      // the module keeps the test independent of matplotlib being installed.
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')
      const base = {
        cwd: root,
        notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
        dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
        runtimeRoot: join(root, 'runtime')
      }
      const fakeArtist = ['class _A:\n    pass', "_A.__module__ = 'matplotlib.lines'"].join('\n')

      try {
        const artist = await executor.execute({ ...base, code: `${fakeArtist}\n_A()` })
        expect(artist).toMatchObject({ status: 'completed', stdout: '' })

        const artistList = await executor.execute({ ...base, code: `${fakeArtist}\n[_A(), _A()]` })
        expect(artistList).toMatchObject({ status: 'completed', stdout: '' })

        // Ordinary data is still echoed.
        const data = await executor.execute({ ...base, code: "{'a': 1}" })
        expect(data.stdout).toBe("{'a': 1}\n")
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'silences the headless matplotlib non-interactive show() warning',
    async () => {
      // Agg warns "FigureCanvasAgg is non-interactive, and thus cannot be shown" on every plt.show()
      // in this headless notebook; the bridge filters that message. Emitting the same warning text
      // keeps the test independent of matplotlib being installed.
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')
      const base = {
        cwd: root,
        notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
        dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
        runtimeRoot: join(root, 'runtime')
      }

      try {
        const result = await executor.execute({
          ...base,
          code: [
            'import warnings',
            'warnings.warn("FigureCanvasAgg is non-interactive, and thus cannot be shown")',
            'print("plotted")'
          ].join('\n')
        })
        expect(result).toMatchObject({ status: 'completed', stdout: 'plotted\n' })
        expect(result.stderr).not.toContain('non-interactive')
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'runs with a non-interactive matplotlib backend so no GUI window opens',
    async () => {
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')

      try {
        const result = await executor.execute({
          code: 'import os\nprint(os.environ.get("MPLBACKEND"))',
          cwd: root,
          notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
          dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
          runtimeRoot: join(root, 'runtime')
        })

        expect(result).toMatchObject({ status: 'completed', stdout: 'Agg\n' })
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'decodes non-ASCII cell code as UTF-8 even when the parent locale codepage is not',
    async () => {
      // Windows repro: Node writes the cell as a UTF-8 JSON line, but Python decodes stdin with the
      // OS locale codepage (cp936 on a Chinese console), corrupting non-ASCII code into lone
      // surrogates and making ast.parse raise UnicodeEncodeError. Forcing the parent PYTHONIOENCODING
      // to a non-UTF-8 codec reproduces that mis-decode portably; the executor must override it to
      // utf-8 so the child still reads the code correctly.
      const root = await createStorageRoot()
      const previous = process.env.PYTHONIOENCODING
      process.env.PYTHONIOENCODING = 'latin-1'
      const executor = new NotebookPythonExecutor('python3')
      const base = {
        cwd: root,
        notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
        dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
        runtimeRoot: join(root, 'runtime')
      }

      // Build the non-ASCII payload from escapes so this source file stays ASCII-only. Covers 2- and
      // 3-byte UTF-8 sequences (e-acute, em dash, snowman), enough that a codepage mis-decode
      // corrupts the round-trip.
      const nonAscii = String.fromCodePoint(0xe9, 0x2014, 0x2603)

      try {
        const result = await executor.execute({
          ...base,
          code: `result = {"term": ${JSON.stringify(nonAscii)}}\nresult`
        })
        expect(result).toMatchObject({ status: 'completed' })
        expect(result.stdout).toBe(`{'term': '${nonAscii}'}\n`)
      } finally {
        await executor.shutdown()
        if (previous === undefined) delete process.env.PYTHONIOENCODING
        else process.env.PYTHONIOENCODING = previous
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'returns a timeout execution result when code exceeds timeoutMs',
    async () => {
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')

      try {
        const result = await executor.execute({
          code: 'import time\ntime.sleep(1)',
          cwd: root,
          notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
          dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
          runtimeRoot: join(root, 'runtime'),
          timeoutMs: 10
        })

        expect(result).toMatchObject({
          status: 'timeout',
          stdout: ''
        })
        expect(result.stderr).toContain('timed out')
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )

  itWithPython(
    'captures direct subprocess stdout instead of treating it as bridge JSON',
    async () => {
      const root = await createStorageRoot()
      const executor = new NotebookPythonExecutor('python3')

      try {
        const result = await executor.execute({
          code: [
            'import subprocess, sys',
            'subprocess.run([sys.executable, "-c", "print(\'Collecting package\')"])',
            'print("done")'
          ].join('\n'),
          cwd: root,
          notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
          dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
          runtimeRoot: join(root, 'runtime')
        })

        expect(result).toMatchObject({
          status: 'completed',
          stdout: 'Collecting package\ndone\n'
        })
      } finally {
        await executor.shutdown()
      }
    },
    PYTHON_TEST_TIMEOUT_MS
  )
})
