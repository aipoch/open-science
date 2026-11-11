import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  binding: vi.fn(),
  run: vi.fn(),
  python: vi.fn()
}))
vi.mock('./compute-account-service', () => ({ computeAccounts: { modalIdentity: mocks.identity } }))
vi.mock('./compute-python-runtime', () => ({
  computePythonRuntime: () => ({ binding: mocks.binding, run: mocks.run }),
  computeHelperPath: () => '/resources/compute-modal.py',
  runComputePython: mocks.python
}))
import * as sdk from './modal-sdk'
const binding = {
  revision: 2,
  python: '/selected/venv/bin/python',
  runtimeRoot: '/runtime',
  prefix: '/selected/venv'
}
const scope = {
  appName: 'jobs',
  environmentName: 'dev',
  appId: 'ap-test',
  nonce: 'nonce',
  volumeName: 'test',
  volumeId: 'vo-test',
  runId: 'run'
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.identity.mockResolvedValue({ tokenId: 'id', tokenSecret: 'secret' })
  mocks.binding.mockResolvedValue(binding)
  mocks.run.mockImplementation(async (_binding, fn) => fn())
  mocks.python.mockImplementation(async (_python, args) =>
    JSON.stringify({
      result:
        args.at(-1) === 'target'
          ? { appId: 'ap-test' }
          : args.at(-1) === 'create-volume'
            ? { volumeId: 'vo-test' }
            : args.at(-1) === 'launch'
              ? { sandboxId: 'sb-test' }
              : args.at(-1) === 'inspect'
                ? { status: 'running', exitCode: null }
                : args.at(-1) === 'list' || args.at(-1) === 'download'
                  ? []
                  : null
    })
  )
})
it('routes every SDK operation through the selected isolated Python after account identity and under its lease', async () => {
  await sdk.resolveModalApp(scope)
  await sdk.createModalVolume(scope)
  await sdk.stageModalInputs({ ...scope, files: [], maxBytes: 0 })
  await sdk.createModalSandbox({
    ...scope,
    image: 'ubuntu',
    command: 'true',
    cpus: 1,
    memoryMiB: 512,
    timeoutSeconds: 60
  })
  await sdk.inspectModalSandbox({ ...scope, sandboxId: 'sb-test' })
  await sdk.terminateModalSandbox({ ...scope, sandboxId: 'sb-test' })
  await sdk.cleanupModalVolume(scope)
  await sdk.listModalJobOutputs(scope)
  await sdk.stageModalJobOutputs({ scope, files: [], stagingDirectory: '/stage', maxBytes: 0 })
  expect(mocks.python).toHaveBeenCalledTimes(9)
  for (let i = 0; i < 9; i++) {
    expect(mocks.identity.mock.invocationCallOrder[i]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[i]
    )
    expect(mocks.run.mock.invocationCallOrder[i]).toBeLessThan(
      mocks.python.mock.invocationCallOrder[i]
    )
    expect(mocks.python.mock.calls[i][0]).toBe(binding.python)
    expect(mocks.python.mock.calls[i][1].slice(0, 3)).toEqual([
      '-I',
      '-B',
      '/resources/compute-modal.py'
    ])
  }
})
it('uses an admitted creation handle without reentering account identity or the environment lease', async () => {
  await sdk.withModalExecution(async (execute) => {
    mocks.binding.mockResolvedValue({ ...binding, python: '/other/python' })
    await sdk.createModalVolume(scope, undefined, execute)
    await sdk.createModalSandbox(
      { ...scope, image: 'ubuntu', command: 'true', cpus: 1, memoryMiB: 512, timeoutSeconds: 60 },
      undefined,
      execute
    )
  })
  expect(mocks.identity).toHaveBeenCalledOnce()
  expect(mocks.run).toHaveBeenCalledOnce()
  expect(mocks.python.mock.calls.map(([python]) => python)).toEqual([
    binding.python,
    binding.python
  ])
})
