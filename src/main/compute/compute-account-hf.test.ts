import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ComputeAccounts } from './compute-accounts'
import { PROTECTED_STRING_PREFIX } from '../secure-storage'
import { afterEach, expect, it, vi } from 'vitest'
import { boundHfAccountAdapter, readLocalHfToken } from './compute-account-hf'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn() }))
vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof import('node:child_process')>()),
  spawn: mocks.spawn
}))
vi.mock('./compute-python-runtime', async (load) => ({
  ...(await load<typeof import('./compute-python-runtime')>()),
  computePythonRuntime: () => ({ run: mocks.run })
}))
let applicationPath = join(process.cwd(), 'app.asar')
const resetOwnership = configureTestRuntimeMetadata(() => ({ applicationPath }))
const binding = {
  revision: 2,
  runtimeRoot: '/runtime',
  prefix: '/chosen',
  python: '/chosen/python'
}
const signal = new AbortController().signal
const adapter = boundHfAccountAdapter(binding)
afterEach(() => {
  applicationPath = join(process.cwd(), 'app.asar')
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
function child(): EventEmitter & {
  stdout: PassThrough
  stdin: PassThrough
  exitCode: number | null
  signalCode: null
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn()
  })
}
it('authorizes with the selected interpreter, official challenge and a lease held through close', async () => {
  const process = child()
  mocks.spawn.mockReturnValue(process)
  let released = false
  mocks.run.mockImplementation(async (target, operation) => {
    expect(target).toBe(binding)
    try {
      return await operation()
    } finally {
      released = true
    }
  })
  const challenge = vi.fn(async () => {})
  const authorized = adapter.authorize(challenge, signal)
  const expiresAt = Date.now() + 60000
  process.stdout.write(
    JSON.stringify({
      url: 'https://huggingface.co/oauth/device?user_code=ABCD',
      userCode: 'ABCD',
      expiresAt
    }) + '\n'
  )
  process.stdout.write(JSON.stringify({ material: { accessToken: 'hf_test' } }) + '\n')
  await Promise.resolve()
  expect(released).toBe(false)
  process.exitCode = 0
  process.emit('close', 0)
  await expect(authorized).resolves.toEqual({ accessToken: 'hf_test' })
  expect(released).toBe(true)
  expect(challenge).toHaveBeenCalledWith(
    'https://huggingface.co/oauth/device?user_code=ABCD',
    'ABCD',
    expiresAt
  )
  expect(mocks.spawn).toHaveBeenCalledWith(
    binding.python,
    [
      '-I',
      '-B',
      join(globalThis.process.cwd(), 'app.asar.unpacked', 'resources', 'compute-hf-auth.py')
    ],
    expect.objectContaining({ killSignal: 'SIGKILL' })
  )
  expect(process.stdin.read()?.toString()).toBe(JSON.stringify({ action: 'authorize' }))
})
it('retains the lease after a helper failure until its child actually closes', async () => {
  const process = child()
  mocks.spawn.mockReturnValue(process)
  let released = false
  mocks.run.mockImplementation(async (_target, operation) => {
    try {
      return await operation()
    } finally {
      released = true
    }
  })
  const authorized = adapter.authorize(vi.fn(), signal)
  const rejected = expect(authorized).rejects.toMatchObject({ reason: 'dependency' })
  process.stdout.write(JSON.stringify({ error: 'dependency' }) + '\n')
  await Promise.resolve()
  expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  expect(released).toBe(false)
  process.emit('close', 0)
  await rejected
  expect(released).toBe(true)
})
it('verifies browser credentials using the selected SDK transport with credentials only on stdin', async () => {
  const process = child()
  mocks.spawn.mockReturnValue(process)
  mocks.run.mockImplementation(async (target, operation) => {
    expect(target).toBe(binding)
    return operation()
  })
  const direct = vi.fn(async () => {
    throw new Error('Direct Node transport cannot reach the issuer')
  })
  vi.stubGlobal('fetch', direct)
  const probed = adapter.probe({ accessToken: 'hf_browser_token' }, signal)
  void probed.catch(() => {})
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
  process.stdout.write(JSON.stringify({ identity: 'researcher' }) + '\n')
  process.exitCode = 0
  process.emit('close', 0)
  await expect(probed).resolves.toBe('researcher')
  expect(direct).not.toHaveBeenCalled()
  expect(process.stdin.read()?.toString()).toBe(
    JSON.stringify({ action: 'probe', accessToken: 'hf_browser_token' })
  )
  expect(mocks.spawn).toHaveBeenCalledWith(
    binding.python,
    expect.any(Array),
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
})
it('reports a missing local identity without sending a probe or claiming authorization was rejected', async () => {
  vi.stubEnv('HF_TOKEN', '')
  vi.stubEnv('HF_ENDPOINT', 'https://huggingface.co')
  vi.stubEnv('HUGGINGFACE_CO_STAGING', '')
  vi.stubEnv('HF_TOKEN_PATH', join(globalThis.process.cwd(), '.scratch', 'missing-hf-local-token'))
  await expect(adapter.probe(undefined, signal)).rejects.toMatchObject({ reason: 'missing' })
  expect(mocks.spawn).not.toHaveBeenCalled()
  await expect(readLocalHfToken(signal, binding)).rejects.toMatchObject({ reason: 'missing' })
})

it('completes the Python authorization, SDK verification and durable account transition when direct Node networking is unavailable', async ({
  skip
}) => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const python =
    globalThis.process.env.OPEN_SCIENCE_TEST_PYTHON ??
    (globalThis.process.platform === 'win32' ? 'python' : 'python3')
  const available = actual.spawnSync(python, ['--version'], { timeout: 10000 })
  if ((available.error as NodeJS.ErrnoException)?.code === 'ENOENT') skip('Python is not installed')
  expect(available.status).toBe(0)
  const root = await mkdtemp(join(tmpdir(), 'hf-completion-'))
  const resources = join(root, 'resources')
  await mkdir(resources)
  applicationPath = root
  const helper = join(globalThis.process.cwd(), 'resources', 'compute-hf-auth.py')
  await writeFile(
    join(resources, 'compute-hf-auth.py'),
    [
      'import runpy, sys, types',
      'hub = types.ModuleType("huggingface_hub"); hub.__path__ = []',
      'hub.constants = types.SimpleNamespace(ENDPOINT="https://huggingface.co")',
      'utils = types.ModuleType("huggingface_hub.utils"); utils.__path__ = []',
      'class Session:',
      '    follow_redirects = True',
      '    def get(self, url, *, headers, timeout):',
      '        assert url == "https://huggingface.co/api/whoami-v2"',
      '        assert headers == {"Authorization":"Bearer hf_fixture_access"}',
      '        assert self.follow_redirects is False and timeout == 15',
      '        return types.SimpleNamespace(status_code=200, raise_for_status=lambda: None, json=lambda: {"name":"researcher"})',
      'session = Session(); utils.get_session = lambda: session',
      'oauth = types.ModuleType("huggingface_hub.utils._oauth_device")',
      'oauth.request_device_code = lambda: {"verification_uri_complete":"https://huggingface.co/oauth/device?user_code=TEST", "user_code":"TEST", "expires_in":60}',
      'oauth.poll_device_token = lambda info: {"access_token":"hf_fixture_access", "refresh_token":"fixture_refresh", "expires_in":3600}',
      'oauth.refresh_access_token = lambda value: {}',
      'sys.modules.update({"huggingface_hub":hub,"huggingface_hub.utils":utils,"huggingface_hub.utils._oauth_device":oauth})',
      `runpy.run_path(${JSON.stringify(helper)}, run_name="__main__")`
    ].join('\n')
  )
  mocks.spawn.mockImplementation(actual.spawn)
  mocks.run.mockImplementation(async (_target, operation) => operation())
  const direct = vi.fn(async () => {
    throw new Error('Direct Node transport is unavailable')
  })
  vi.stubGlobal('fetch', direct)
  const openExternal = vi.fn(async () => {})
  const owner = new ComputeAccounts({
    configRoot: () => root,
    openExternal,
    protection: {
      isAvailable: () => true,
      protect: (value) => PROTECTED_STRING_PREFIX + Buffer.from(value).toString('base64'),
      reveal: (value) =>
        Buffer.from(value.slice(PROTECTED_STRING_PREFIX.length), 'base64').toString()
    }
  })
  const controller = new AbortController()
  try {
    expect(
      await owner.connect('hugging-face', {
        adapter: boundHfAccountAdapter({ ...binding, python }),
        signal: controller.signal,
        operationId: 'complete-browser',
        revision: 2,
        assertCurrent: () => {}
      })
    ).toMatchObject({ state: 'pending' })
    await vi.waitFor(
      async () =>
        expect(await owner.status('hugging-face')).toMatchObject({
          state: 'connected',
          source: 'managed',
          identity: 'researcher'
        }),
      { timeout: 5000 }
    )
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      'https://huggingface.co/oauth/device?user_code=TEST'
    )
    expect(direct).not.toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    const saved = await readFile(join(root, 'compute-hugging-face-account.json'), 'utf8')
    expect(saved).not.toContain('hf_fixture_access')
    expect(await owner.cancelOperation('hugging-face', 'complete-browser')).toMatchObject({
      state: 'connected'
    })
  } finally {
    controller.abort()
    await owner.cancelOperation('hugging-face', 'complete-browser')
    await resetOwnership()
    await rm(root, { recursive: true, force: true })
  }
})

it('ends post-login verification with a timeout independently of the browser authorization deadline', async () => {
  const deadline = new AbortController()
  const caller = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  const process = child()
  mocks.run.mockImplementation(async (_target, operation) => operation())
  mocks.spawn.mockImplementation((_python, _args, options) => {
    options.signal.addEventListener(
      'abort',
      () => {
        process.emit('error', Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }))
        process.emit('close', 1)
      },
      { once: true }
    )
    return process
  })
  const completed = adapter.probe({ accessToken: 'hf_fixture_access' }, caller.signal)
  const rejected = expect(completed).rejects.toMatchObject({ reason: 'timeout' })
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
  deadline.abort()
  await rejected
  expect(caller.signal.aborted).toBe(false)
})
