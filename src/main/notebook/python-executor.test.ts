import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
