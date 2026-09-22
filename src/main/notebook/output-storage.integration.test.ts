import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { notebookOutputPage } from './output-page'
import { ensureNotebookOutputDirectory, notebookOutputRequestId } from './output-storage'
import { framePythonRequest, frameRRequest } from './kernel-protocol'

const runLoop = (
  command: string,
  loop: string,
  input: string | Buffer,
  directory: string
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [loop], {
      env: {
        ...process.env,
        OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR: directory,
        ELECTRON_RUN_AS_NODE: '1'
      }
    })
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))))
    child.stdin.end(input)
  })

describe('durable full Notebook output', () => {
  it.for([
    {
      name: 'Python',
      command: 'python3',
      loop: 'python_loop.py',
      code: "print('x' * (3 * 1024 * 1024) + 'FINAL_SENTINEL')"
    },
    {
      name: 'REPL',
      command: process.execPath,
      loop: 'repl_loop.js',
      code: "console.log('x'.repeat(3 * 1024 * 1024) + 'FINAL_SENTINEL')"
    }
  ])(
    'retains >2MiB $name output and reads the tail in a bounded page',
    { timeout: 30_000 },
    async ({ command, loop, code }, context) => {
      if (command === 'python3' && spawnSync(command, ['--version']).status !== 0) context.skip()
      const root = await mkdtemp(join(tmpdir(), 'notebook-full-output-'))
      try {
        const runId = 'run-full'
        const requestId = notebookOutputRequestId(runId)
        const directory = ensureNotebookOutputDirectory(root)
        const response = JSON.parse(
          (
            await runLoop(
              command,
              join(__dirname, '../../../resources/notebook', loop),
              framePythonRequest(requestId, code),
              directory
            )
          ).trim()
        )
        expect(response.output_truncated).toBe(true)
        expect(response.stdout).not.toContain('FINAL_SENTINEL')
        const saved = await readFile(join(directory, requestId + '.txt'), 'utf8')
        expect(saved).toContain('FINAL_SENTINEL')
        const result = await notebookOutputPage(
          {
            notebookSessionRoot: root,
            runs: [
              { runId, status: 'completed', truncated: true, text: { stdout: response.stdout } }
            ]
          },
          { outputRunId: runId, outputOffset: Buffer.byteLength(saved) - 100, outputLimit: 4000 }
        )
        expect(JSON.stringify(result)).toContain('FINAL_SENTINEL')
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(5000)
        expect(result).toMatchObject({
          outputPage: { captureTruncated: false, offsetUnit: 'utf8-bytes' }
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(spawnSync('Rscript', ['--version']).status !== 0)(
    'retains R stdout beyond the display cap',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'notebook-full-r-output-'))
      try {
        const requestId = notebookOutputRequestId('r-run')
        const directory = ensureNotebookOutputDirectory(root)
        const response = await runLoop(
          'Rscript',
          join(__dirname, '../../../resources/notebook/r_loop.R'),
          frameRRequest(requestId, 'cat(strrep("x", 3 * 1024 * 1024), "FINAL_SENTINEL")'),
          directory
        )
        expect(response).not.toContain('FINAL_SENTINEL')
        expect(await readFile(join(directory, requestId + '.txt'), 'utf8')).toContain(
          'FINAL_SENTINEL'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it('rejects an output directory symlink and never resolves a run outside Session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-output-scope-'))
    const outside = await mkdtemp(join(tmpdir(), 'notebook-output-outside-'))
    try {
      await writeFile(join(outside, notebookOutputRequestId('r') + '.txt'), 'private')
      await symlink(
        outside,
        join(root, 'outputs'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      await expect(
        notebookOutputPage(
          { notebookSessionRoot: root, runs: [{ runId: 'r', status: 'completed' }] },
          { outputRunId: 'r' }
        )
      ).rejects.toThrow('escaped its Session')
      await expect(
        notebookOutputPage({ notebookSessionRoot: root, runs: [] }, { outputRunId: 'r' })
      ).rejects.toThrow('not found')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
