import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runWindowsBrowserDiagnostics } from './run-windows-browser-diagnostics.mjs'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync)
  }
})

const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
let root: string
let output: string
let testChild: ChildProcess

beforeEach(() => {
  vi.mocked(spawn).mockReset()
  vi.mocked(execFile).mockReset()
  vi.mocked(execFileSync).mockReset()
  root = mkdtempSync(join(tmpdir(), 'windows-browser-diagnostics-'))
  output = join(root, 'samples.ndjson')
})

afterEach(() => {
  testChild?.kill()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

// Substitute only the platform commands, using real Node child exits. These checks exercise
// runner ownership/exit propagation, not a reproduction of the Windows network failure.
const layout = (code: number, immediate = false): void => {
  vi.mocked(spawn).mockImplementation(() => {
    testChild = actual.spawn(process.execPath, [
      '-e',
      immediate
        ? `process.exit(${code})`
        : `process.stdin.once('data', () => process.exit(${code}))`
    ])
    return testChild
  })
}

const records = (): Array<Record<string, unknown>> =>
  readFileSync(output, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

it.each([0, 7])('preserves layout exit %i after a successful sample', async (code) => {
  layout(code)
  vi.mocked(execFile).mockImplementation((_file, _args, options, callback) =>
    actual.execFile(
      process.execPath,
      ['-e', 'console.log(JSON.stringify({processes:[],tcpStates:[],loopback4178States:[]}))'],
      options,
      (error, stdout, stderr) => {
        callback!(error, stdout, stderr)
        testChild.stdin!.end('finish')
      }
    )
  )
  expect(await runWindowsBrowserDiagnostics(join(root, "layout's script.tmp"), output)).toBe(code)
  expect(records()).toEqual([
    expect.objectContaining({
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      status: 'ok',
      processes: [],
      tcpStates: [],
      loopback4178States: []
    })
  ])
  expect(execFile).toHaveBeenCalledOnce()
  expect(execFile).toHaveBeenCalledWith(
    'powershell.exe',
    expect.any(Array),
    expect.objectContaining({ timeout: 4000, maxBuffer: 1024 * 1024 }),
    expect.any(Function)
  )
  expect(spawn).toHaveBeenCalledWith(
    'pwsh',
    expect.arrayContaining([
      expect.stringContaining("layout''s script.tmp"),
      expect.stringContaining('exit $LASTEXITCODE')
    ]),
    { stdio: 'inherit' }
  )
})

it.each([0, 7])('preserves exit %i when starting the sampler throws', async (code) => {
  layout(code, true)
  vi.mocked(execFile).mockImplementation(() => {
    throw new Error('query unavailable')
  })
  expect(await runWindowsBrowserDiagnostics('layout.tmp', output)).toBe(code)
  expect(records()).toEqual([
    expect.objectContaining({ status: 'error', code: 'sample-start-failed' })
  ])
  expect(records()[0]).not.toHaveProperty('tcpStates')
})

it.each([
  ['process.exit(3)', 3],
  ["console.log('invalid JSON')", 'invalid-json']
])('records a query failure without reporting zero resources: %s', async (source, errorCode) => {
  layout(0)
  vi.mocked(execFile).mockImplementation((_file, _args, options, callback) =>
    actual.execFile(process.execPath, ['-e', String(source)], options, (error, stdout, stderr) => {
      callback!(error, stdout, stderr)
      testChild.stdin!.end('finish')
    })
  )
  expect(await runWindowsBrowserDiagnostics('layout.tmp', output)).toBe(0)
  expect(records()[0]).toMatchObject({ status: 'error', code: errorCode })
  expect(records()[0]).not.toHaveProperty('tcpStates')
})

it('kills and waits for its in-flight sampler after a real nonzero test exit', async () => {
  layout(7, true)
  let sampler: ChildProcess | undefined
  vi.mocked(execFile).mockImplementation((_file, _args, options, callback) => {
    sampler = actual.execFile(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      options,
      callback
    )
    vi.spyOn(sampler, 'kill')
    return sampler
  })
  expect(await runWindowsBrowserDiagnostics('layout.tmp', output)).toBe(7)
  expect(sampler!.kill).toHaveBeenCalledOnce()
  expect(sampler!.signalCode).not.toBeNull()
  expect(records()[0]).toMatchObject({
    status: 'error',
    reason: 'cleanup',
    killed: true,
    signal: expect.any(String)
  })
})

it('distinguishes a query deadline from intentional cleanup', async () => {
  layout(0)
  vi.mocked(execFile).mockImplementation((_file, _args, options, callback) =>
    // Exercise execFile's real timeout callback without spending four seconds in the unit test.
    actual.execFile(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { ...options, timeout: 50 },
      (error, stdout, stderr) => {
        callback!(error, stdout, stderr)
        testChild.stdin!.end('finish')
      }
    )
  )
  expect(await runWindowsBrowserDiagnostics('layout.tmp', output)).toBe(0)
  expect(records()[0]).toMatchObject({
    reason: 'query-timeout',
    code: null,
    killed: true,
    signal: expect.any(String)
  })
})

it.each([0, 7])('confirms owned taskkill cleanup without replacing exit %i', async (code) => {
  layout(code, true)
  const sampler = {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => {
      throw new Error('stop failed')
    }),
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    unref: vi.fn()
  }
  vi.mocked(execFile).mockReturnValue(sampler as unknown as ReturnType<typeof execFile>)
  vi.mocked(execFileSync).mockImplementation(() => {
    sampler.signalCode = 'SIGTERM'
    return Buffer.alloc(0)
  })
  expect(await runWindowsBrowserDiagnostics('layout.tmp', output)).toBe(code)
  expect(records().map((record) => record.code)).toEqual([
    'sample-stop-failed',
    'sample-stop-timeout',
    'sample-exit-confirmed'
  ])
  expect(sampler.stdout.destroy).toHaveBeenCalledOnce()
  expect(sampler.unref).toHaveBeenCalledOnce()
  expect(execFile).toHaveBeenCalledOnce()
  expect(execFileSync).toHaveBeenCalledWith('taskkill.exe', ['/PID', '12345', '/T', '/F'], {
    timeout: 1000,
    windowsHide: true,
    stdio: 'ignore'
  })
})

it('reports failed fallback and unconfirmed exit without masking the test result', async () => {
  layout(7, true)
  const sampler = {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => false),
    unref: vi.fn()
  }
  vi.mocked(execFile).mockReturnValue(sampler as unknown as ReturnType<typeof execFile>)
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('taskkill timed out')
  })
  expect(await runWindowsBrowserDiagnostics('layout.tmp', output)).toBe(7)
  expect(records().map((record) => record.code)).toEqual([
    'sample-stop-failed',
    'sample-stop-timeout',
    'sample-taskkill-failed',
    'sample-exit-unconfirmed'
  ])
})

it('keeps a diagnostic write failure from masking the test failure', async () => {
  layout(7, true)
  writeFileSync(output, 'a file cannot contain child files')
  vi.mocked(execFile).mockImplementation(() => {
    throw new Error('unavailable')
  })
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await runWindowsBrowserDiagnostics('layout.tmp', join(output, 'child'))).toBe(7)
  expect(warn).toHaveBeenCalledWith('Windows browser diagnostics: could not write sample.')
})

it('wraps only the Windows layout shell and preserves its original command', () => {
  const workflow = load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ id?: string; shell?: string; run?: string }> }>
  }
  const wrapped = Object.entries(workflow.jobs).flatMap(([job, value]) =>
    (value.steps ?? [])
      .filter((step) => step.shell?.includes('run-windows-browser-diagnostics.mjs'))
      .map((step) => ({ job, ...step }))
  )
  expect(wrapped).toEqual([
    expect.objectContaining({
      job: 'windows_e2e',
      id: 'renderer_layout',
      shell: 'node scripts/ci/run-windows-browser-diagnostics.mjs {0}',
      run: 'npm run test:e2e:browser -- --fail-on-flaky-tests --global-timeout=180000'
    })
  ])
  expect(
    workflow.jobs.windows_core.steps?.find((step) => step.id === 'windows_runtime')?.run
  ).toContain('scripts/ci/run-windows-browser-diagnostics.test.ts')
})

it.skipIf(process.platform !== 'win32').each([0, 7])(
  'preserves native exit %i through the real PowerShell shell',
  async (code) => {
    vi.mocked(spawn).mockImplementation(actual.spawn)
    vi.mocked(execFile).mockImplementation(() => {
      throw new Error('diagnostics unavailable')
    })
    const script = join(root, "layout's script.tmp")
    writeFileSync(
      script,
      `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(${code})'`
    )
    expect(await runWindowsBrowserDiagnostics(script, output)).toBe(code)
  }
)

it.skipIf(process.platform !== 'win32')(
  'collects an actual Windows process and TCP sample',
  async () => {
    layout(0)
    // This smoke checks the native query/schema, not the best-effort sampling deadline.
    // CIM/NetTCPConnection cold starts can exceed four seconds on shared Windows runners.
    // Keep the layout alive until the query completes instead of racing a fixed sleep.
    vi.mocked(execFile).mockImplementation((file, args, options, callback) =>
      actual.execFile(file, args, { ...options, timeout: 30_000 }, (error, stdout, stderr) => {
        callback!(error, stdout, stderr)
        testChild.stdin!.end('finish')
      })
    )
    vi.mocked(execFileSync).mockImplementation(actual.execFileSync)
    expect(await runWindowsBrowserDiagnostics('native-query.tmp', output)).toBe(0)
    const sample = records().find((record) => record.status === 'ok')
    expect(sample, JSON.stringify(records())).toMatchObject({
      processes: expect.arrayContaining([
        expect.objectContaining({
          ProcessId: process.pid,
          Name: 'node.exe',
          CreationDate: expect.anything(),
          HandleCount: expect.anything(),
          WorkingSetSize: expect.anything(),
          PrivatePageCount: expect.anything()
        })
      ]),
      tcpStates: expect.any(Array),
      loopback4178States: expect.any(Array)
    })
  },
  40_000
)
