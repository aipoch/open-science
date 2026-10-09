import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

import { flushLogs, initLogger } from '../logger'
import { probeInterpreterVersion } from './python-command'

describe('Python interpreter probe diagnostics', () => {
  it('retries only successful empty Windows output with the same invocation and remaining deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_250)
    const env = { PATH: 'same-path' }
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Python 3.12.7', stderr: '' })
    try {
      await expect(
        probeInterpreterVersion('py', ['-3'], { platform: 'win32', exec, env })
      ).resolves.toBe('3.12.7')
      expect(exec).toHaveBeenCalledTimes(2)
      for (const [index, timeout] of [10_000, 9_750].entries()) {
        expect(exec).toHaveBeenNthCalledWith(index + 1, 'py', ['-3', '--version'], {
          timeout,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          shell: false,
          env
        })
      }
    } finally {
      clock.mockRestore()
    }
  })

  it.each([
    { platform: 'win32' as const, elapsed: 0, attempts: 5 },
    { platform: 'linux' as const, elapsed: 0, attempts: 1 },
    { platform: 'win32' as const, elapsed: 10_000, attempts: 1 }
  ])('bounds empty output attempts and logs once: %j', async ({ platform, elapsed, attempts }) => {
    const logDir = await mkdtemp(join(tmpdir(), 'python-probe-empty-'))
    initLogger({ logDir, mirrorToConsole: false })
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(elapsed)
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }))
    try {
      await expect(
        probeInterpreterVersion('python', [], { platform, exec })
      ).resolves.toBeUndefined()
      expect(exec).toHaveBeenCalledTimes(attempts)
      await flushLogs()
      const record = JSON.parse((await readFile(join(logDir, 'main.log'), 'utf8')).trim())
      expect(record.data).toMatchObject({ code: 'INVALID_PYTHON3_VERSION', attempts })
    } finally {
      clock.mockRestore()
      await flushLogs()
      await rm(logDir, { recursive: true, force: true })
    }
  })

  it.each([
    { stdout: ' ', stderr: '' },
    { stdout: 'Python 2.7.18', stderr: '' },
    { stdout: 'invalid', stderr: '' },
    { stdout: '', stderr: ' ' },
    { stdout: '', stderr: 'startup warning' }
  ])('does not retry nonempty Windows output %j', async (output) => {
    const exec = vi.fn(async () => output)
    await expect(
      probeInterpreterVersion('python', [], { platform: 'win32', exec })
    ).resolves.toBeUndefined()
    expect(exec).toHaveBeenCalledOnce()
  })

  it.each([
    { code: 1 },
    { code: 'ENOENT' },
    { killed: true, signal: 'SIGTERM' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
  ])('does not retry rejected Windows probes %j', async (failure) => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('probe failed'), failure))
    await expect(
      probeInterpreterVersion('python', [], { platform: 'win32', exec })
    ).resolves.toBeUndefined()
    expect(exec).toHaveBeenCalledOnce()
  })

  it('passes executable paths and launcher arguments directly with bounded subprocess output', async () => {
    const command = 'E:\\Program Files (vee)\\Python3.13.3\\python.exe'
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'Python 3.13.3\r\n' }))
    const env = { PATH: 'interpreter-path' }

    await expect(probeInterpreterVersion(command, [], { exec, env })).resolves.toBe('3.13.3')
    expect(exec).toHaveBeenCalledWith(command, ['--version'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
      env
    })
    await expect(probeInterpreterVersion('py', ['-3'], { exec })).resolves.toBe('3.13.3')
    expect(exec).toHaveBeenLastCalledWith(
      'py',
      ['-3', '--version'],
      expect.objectContaining({ shell: false })
    )
  })

  it('extracts the probe version line without including interpreter warnings', async () => {
    await expect(
      probeInterpreterVersion('python', [], {
        exec: async () => ({ stdout: 'Python 3.13.0rc1\r\n', stderr: 'startup warning\n' })
      })
    ).resolves.toBe('3.13.0rc1')
  })

  it('skips adversarial malformed version lines within a bounded subprocess', async () => {
    // Run the production module outside Vitest so a backtracking regression can be killed.
    const bundle = await build({
      stdin: {
        contents: `
          import { probeInterpreterVersion } from './src/main/notebook/python-command'
          const malformed = 'Python 3' + '.1'.repeat(40) + '!'
          const version = await probeInterpreterVersion('python', [], {
            exec: async () => ({ stdout: malformed + '\\nPython 3.14.0rc1+local.1\\n', stderr: '' })
          })
          if (version !== '3.14.0rc1+local.1') throw new Error('Unexpected version: ' + version)
          console.log(version)
        `,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false
    })
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', bundle.outputFiles[0].text],
      { timeout: 5_000, windowsHide: true }
    )
    expect(stdout.trim()).toBe('3.14.0rc1+local.1')
  }, 15_000)

  it.each(['', 'not a Python version', 'Python 3.14.0!', 'Python 30.1', 'Python 3.'])(
    'rejects successful probes with invalid output %j',
    async (stdout) => {
      const logDir = await mkdtemp(join(tmpdir(), 'python-probe-invalid-output-'))
      initLogger({ logDir, mirrorToConsole: false })
      try {
        await expect(
          probeInterpreterVersion('python', [], {
            exec: async () => ({ stdout, stderr: '' })
          })
        ).resolves.toBeUndefined()
        await flushLogs()
        const record = JSON.parse((await readFile(join(logDir, 'main.log'), 'utf8')).trim())
        expect(record.data).toMatchObject({
          code: 'INVALID_PYTHON3_VERSION',
          timedOut: false,
          stdout,
          stderr: ''
        })
      } finally {
        await flushLogs()
        await rm(logDir, { recursive: true, force: true })
      }
    }
  )

  it('redacts JWT credentials before truncating probe output and failure messages', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'python-probe-redaction-'))
    initLogger({ logDir, mirrorToConsole: false })
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ privateValue: 'private-payload-'.repeat(200) })).toString(
        'base64url'
      ),
      Buffer.from('signature-sentinel').toString('base64url')
    ].join('.')
    const output = `${jwt}\n${'x'.repeat(5000)}`
    expect(jwt.length).toBeGreaterThan(2048)
    try {
      await expect(
        probeInterpreterVersion('python', [], {
          exec: async () => ({ stdout: output, stderr: output })
        })
      ).resolves.toBeUndefined()
      await expect(
        probeInterpreterVersion('python', [], {
          exec: async () => {
            throw Object.assign(new Error(output), { code: 1, stdout: output, stderr: output })
          }
        })
      ).resolves.toBeUndefined()
      await flushLogs()
      const content = await readFile(join(logDir, 'main.log'), 'utf8')
      expect(content).not.toContain(jwt.slice(0, 128))
      const records = content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(records).toHaveLength(2)
      for (const data of records.map((record) => record.data)) {
        for (const text of [data.stdout, data.stderr, data.message].filter(
          (text) => text !== undefined
        )) {
          expect(text).toContain('[redacted]')
          expect(text).toContain('[truncated]')
          expect(text.length).toBeLessThanOrEqual(2060)
        }
      }
    } finally {
      await flushLogs()
      await rm(logDir, { recursive: true, force: true })
    }
  })

  it('writes a bounded, locatable reason for version, launch, timeout and output-limit failures', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'python-probe-diagnostics-'))
    initLogger({ logDir, mirrorToConsole: false })
    const command = 'E:\\Program Files (vee)\\broken-python.exe'
    const env = { PATH: 'private-environment-sentinel' }
    try {
      await expect(
        probeInterpreterVersion(command, [], {
          env,
          exec: async () => ({ stdout: 'Python 2.7.18', stderr: '' })
        })
      ).resolves.toBeUndefined()
      for (const failure of [
        { code: 'ENOENT' },
        { code: null, signal: 'SIGTERM', killed: true },
        { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }
      ]) {
        await expect(
          probeInterpreterVersion(command, [], {
            env,
            exec: async () => {
              throw Object.assign(new Error('Python subprocess failed'), failure, {
                stdout: 'o'.repeat(10_000),
                stderr: 'DLL load failed: ' + 'e'.repeat(10_000)
              })
            }
          })
        ).resolves.toBeUndefined()
      }
      await flushLogs()
      const content = await readFile(join(logDir, 'main.log'), 'utf8')
      const records = content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(records).toHaveLength(4)
      expect(content).not.toContain(env.PATH)
      for (const record of records) {
        expect(record.scope).toBe('notebook:python-command')
        expect(record.data).toMatchObject({ command, phase: 'version' })
        expect(record.data.stdout.length).toBeLessThanOrEqual(2060)
        expect(record.data.stderr.length).toBeLessThanOrEqual(2060)
      }
      expect(records[0].data).toMatchObject({ code: 'INVALID_PYTHON3_VERSION', timedOut: false })
      expect(records[1].data).toMatchObject({ code: 'ENOENT', timedOut: false })
      expect(records[2].data).toMatchObject({
        signal: 'SIGTERM',
        timedOut: true,
        timeoutMs: 10_000
      })
      expect(records[3].data).toMatchObject({
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        timedOut: false
      })
      expect(records[1].data.stderr).toContain('DLL load failed:')
      expect(records[1].data.stderr).toContain('[truncated]')
    } finally {
      await flushLogs()
      await rm(logDir, { recursive: true, force: true })
    }
  })
})
