import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { DEFAULT_PY_ENV, envPrefix, pythonBin } from '@aipoch/environment'
import type { DiscoveredInterpreter } from '@aipoch/environment/contracts'
import { z } from 'zod'
import type {
  ComputeAccountOperation,
  ComputePythonFailure,
  ComputePythonResult,
  ComputePythonSelection,
  ComputePythonSelect,
  ComputePythonSnapshot
} from '../../shared/compute-python-runtime'
import { computeAccountProviders, type ComputeAccountProvider } from '../../shared/compute-accounts'
import { runtimeMetadata } from '../runtime-metadata'
import { withDataRootWrite } from '../storage/migration-state'
import type { NotebookRuntimeService } from '../notebook/runtime-service'

export type ComputePythonBinding = Readonly<{
  revision: number
  runtimeRoot: string
  python: string
  environment?: string
  prefix: string
}>
type Dependencies = {
  runtimeRoot: () => string
  getSelection: () => Promise<ComputePythonSelection | undefined>
  saveSelection: (selection: ComputePythonSelection) => Promise<void>
  listPython: () => Promise<DiscoveredInterpreter[]>
  defaultReady: () => Promise<boolean>
  provision: (operationId: string) => Promise<void>
  runtime: Pick<
    NotebookRuntimeService,
    'withPythonExecution' | 'assertPythonExecutionAllowed' | 'managePackages'
  >
  commit: <T>(operation: () => Promise<T>) => Promise<T>
}
export class ComputePythonError extends Error {
  constructor(readonly reason: ComputePythonFailure) {
    super(reason)
  }
}
export function computeHelperPath(
  helper:
    | 'compute-modal.py'
    | 'compute-modal-auth.py'
    | 'compute-modal-check.py'
    | 'compute-hf-auth.py'
    | 'compute-hf-check.py'
): string {
  const { applicationPath } = runtimeMetadata()
  const root =
    basename(applicationPath) === 'app.asar' ? applicationPath + '.unpacked' : applicationPath
  return join(root, 'resources', helper)
}

// Abort/timeout callbacks can precede close. Never release an environment lease until close.
export async function runComputePython(
  python: string,
  args: string[],
  input: string | undefined,
  signal?: AbortSignal,
  timeout = 10000,
  maxBuffer = 16384
): Promise<string> {
  signal?.throwIfAborted()
  let closed!: Promise<void>
  const complete = new Promise<string>((resolve, reject) => {
    const child = execFile(
      python,
      args,
      { encoding: 'utf8', signal, timeout, maxBuffer, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
    closed = new Promise((resolve) => child.once('close', () => resolve()))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
  try {
    return await complete
  } finally {
    await closed
  }
}
const checkSchema = z.strictObject({
  prefix: z.string().min(1),
  version: z.string().optional(),
  error: z.enum(['missing', 'version', 'imports', 'proxy']).optional()
})
const waitForSupply = (supply: Promise<void>, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cancel = (): void => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    supply.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  })
function failure(error: unknown, signal: AbortSignal): ComputePythonFailure {
  if (signal.aborted) return 'cancelled'
  if (error instanceof ComputePythonError) return error.reason
  const message = error instanceof Error ? error.message : ''
  if (message.includes('RUNTIME_STALE')) return 'runtime-stale'
  if (/disabled/i.test(message)) return 'disabled'
  if (/RECOVERY|REPAIR|IDENTITY/i.test(message)) return 'recovery'
  return 'dependency'
}
const specifications = {
  modal: {
    override: 'OPEN_SCIENCE_MODAL_PYTHON',
    helper: 'compute-modal-check.py',
    version: '1.6.3',
    packages: ['modal==1.6.3', 'python-socks', 'aiohttp-socks']
  },
  'hugging-face': {
    override: 'OPEN_SCIENCE_HF_PYTHON',
    helper: 'compute-hf-check.py',
    version: '2.4.0',
    packages: ['huggingface_hub==2.4.0', 'socksio']
  }
} as const
export class ComputePythonRuntime {
  private revision = 0
  private active?: { id: string; controller: AbortController; done: Promise<unknown> }
  constructor(
    private readonly deps: Dependencies,
    private readonly provider: ComputeAccountProvider
  ) {}
  currentRevision(): number {
    return this.revision
  }
  private async selection(): Promise<ComputePythonSelection> {
    return (
      (await this.deps.getSelection()) ??
      (process.env[specifications[this.provider].override]
        ? { kind: 'custom', pythonPath: process.env[specifications[this.provider].override]! }
        : { kind: 'managed' })
    )
  }
  async get(): Promise<ComputePythonSnapshot> {
    const candidates = await this.deps.listPython()
    // Discovery can outlive a source commit. Pair the saved selection with its own revision.
    for (;;) {
      const revision = this.revision
      const selection = await this.selection()
      if (revision === this.revision) return { selection, revision, candidates }
    }
  }
  assertCurrent(context: ComputeAccountOperation, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (
      this.active?.id !== context.operationId ||
      this.active.controller.signal.aborted ||
      context.revision !== this.revision
    )
      throw new ComputePythonError('runtime-stale')
  }
  cancel(id: string): boolean {
    if (this.active?.id !== id) return false
    this.active.controller.abort()
    return true
  }
  private operation<T>(
    context: ComputeAccountOperation,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (context.revision !== this.revision)
      return Promise.reject(new ComputePythonError('runtime-stale'))
    const previous = this.active
    if (previous?.id === context.operationId && !previous.controller.signal.aborted)
      return Promise.reject(new ComputePythonError('runtime-stale'))
    previous?.controller.abort()
    const controller = new AbortController()
    const operation = {
      id: context.operationId,
      controller,
      done: Promise.resolve() as Promise<unknown>
    }
    this.active = operation
    operation.done = (async () => {
      await previous?.done.catch(() => {})
      this.assertCurrent(context, controller.signal)
      return fn(controller.signal)
    })()
    return operation.done as Promise<T>
  }
  async binding(signal?: AbortSignal): Promise<ComputePythonBinding> {
    const selection = await this.selection()
    return this.resolve(selection, this.revision, signal)
  }
  private async resolve(
    selection: ComputePythonSelection,
    revision: number,
    signal?: AbortSignal
  ): Promise<ComputePythonBinding> {
    return withDataRootWrite(async () => {
      const runtimeRoot = this.deps.runtimeRoot()
      const python =
        selection.kind === 'managed'
          ? pythonBin(envPrefix(runtimeRoot, DEFAULT_PY_ENV))
          : selection.pythonPath
      if (!isAbsolute(python)) throw new ComputePythonError('dependency')
      let prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
      let environment: string | undefined =
        selection.kind === 'managed' ? DEFAULT_PY_ENV : undefined
      if (selection.kind === 'custom') {
        // sys.prefix preserves venv semantics even when its executable is a symlink to base Python.
        prefix = z
          .string()
          .min(1)
          .parse(
            JSON.parse(
              await runComputePython(
                python,
                ['-I', '-B', '-c', 'import sys,json; print(json.dumps(sys.prefix))'],
                undefined,
                signal
              )
            )
          )
        const canonical = (path: string): string => {
          try {
            return realpathSync(path)
          } catch {
            return path
          }
        }
        const name = relative(canonical(join(runtimeRoot, 'envs')), canonical(prefix))
        if (name && !name.includes('/') && !name.includes('\\') && name !== '..') {
          environment =
            canonical(prefix) === canonical(envPrefix(runtimeRoot, DEFAULT_PY_ENV))
              ? DEFAULT_PY_ENV
              : name
        }
      }
      return Object.freeze({ revision, runtimeRoot, python, prefix, environment })
    })
  }
  run<T>(
    binding: ComputePythonBinding,
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (binding.runtimeRoot !== this.deps.runtimeRoot())
      return Promise.reject(new ComputePythonError('runtime-stale'))
    return this.deps.runtime.withPythonExecution(
      binding,
      async () => {
        if (binding.runtimeRoot !== this.deps.runtimeRoot())
          throw new ComputePythonError('runtime-stale')
        return operation()
      },
      signal
    )
  }
  private async check(binding: ComputePythonBinding, signal: AbortSignal): Promise<boolean> {
    return this.run(
      binding,
      async () => {
        const result = checkSchema.parse(
          JSON.parse(
            await runComputePython(
              binding.python,
              ['-I', '-B', computeHelperPath(specifications[this.provider].helper)],
              undefined,
              signal
            )
          )
        )
        if (result.prefix !== binding.prefix) throw new ComputePythonError('runtime-stale')
        return !result.error && result.version === specifications[this.provider].version
      },
      signal
    )
  }
  select(request: ComputePythonSelect): Promise<ComputePythonResult> {
    return this.operation(request, async (signal) => {
      try {
        if (
          request.selection.kind === 'custom' &&
          !(await this.check(await this.resolve(request.selection, this.revision, signal), signal))
        )
          throw new ComputePythonError('dependency')
        await this.deps.commit(async () => {
          this.assertCurrent(request, signal)
          try {
            await this.deps.saveSelection(request.selection)
          } catch {
            throw new ComputePythonError('storage')
          }
          // Persistence is the commit point. Publish even if cancellation arrived during the write.
          this.revision++
        })
        return { revision: this.revision }
      } catch (error) {
        return { revision: this.revision, runtimeError: failure(error, signal) }
      }
    }).catch((error) => ({
      revision: this.revision,
      runtimeError: error instanceof ComputePythonError ? error.reason : 'cancelled'
    }))
  }
  prepare(
    context: ComputeAccountOperation
  ): Promise<{ binding: ComputePythonBinding; signal: AbortSignal }> {
    return this.operation(context, async (signal) => {
      let preparingManaged = false
      try {
        const selection = await this.selection()
        preparingManaged = selection.kind === 'managed'
        if (selection.kind === 'managed') {
          await withDataRootWrite(async () => {
            const root = this.deps.runtimeRoot()
            await this.deps.runtime.assertPythonExecutionAllowed(
              DEFAULT_PY_ENV,
              pythonBin(envPrefix(root, DEFAULT_PY_ENV))
            )
          })
          if (!(await this.deps.defaultReady()))
            await waitForSupply(this.deps.provision(context.operationId), signal)
        }
        this.assertCurrent(context, signal)
        let binding = await this.resolve(selection, context.revision, signal)
        if (!(await this.check(binding, signal))) {
          if (selection.kind !== 'managed') throw new ComputePythonError('dependency')
          await withDataRootWrite(async () => {
            this.assertCurrent(context, signal)
            if (binding.runtimeRoot !== this.deps.runtimeRoot())
              throw new ComputePythonError('runtime-stale')
            await this.deps.runtime.assertPythonExecutionAllowed(DEFAULT_PY_ENV, binding.python)
            const result = await this.deps.runtime.managePackages(
              {
                language: 'python',
                environment: DEFAULT_PY_ENV,
                // The additive default policy accepts bare names and exact pins, not extras syntax.
                packages: [...specifications[this.provider].packages],
                usePip: true
              },
              signal
            )
            if (!result.ok) {
              const reason = failure(new Error(result.error ?? ''), signal)
              throw new ComputePythonError(reason === 'dependency' ? 'install' : reason)
            }
          })
          binding = await this.resolve(selection, context.revision, signal)
          if (!(await this.check(binding, signal))) throw new ComputePythonError('dependency')
        }
        this.assertCurrent(context, signal)
        return { binding, signal }
      } catch (error) {
        const reason = failure(error, signal)
        throw new ComputePythonError(
          preparingManaged && reason === 'dependency' ? 'install' : reason
        )
      }
    })
  }
}
type SharedDependencies = Omit<Dependencies, 'getSelection' | 'saveSelection' | 'commit'> & {
  getSelection: (provider: ComputeAccountProvider) => Promise<ComputePythonSelection | undefined>
  saveSelection: (
    provider: ComputeAccountProvider,
    selection: ComputePythonSelection
  ) => Promise<void>
  commit: <T>(provider: ComputeAccountProvider, operation: () => Promise<T>) => Promise<T>
}
const owners = new Map<ComputeAccountProvider, ComputePythonRuntime>()
export function configureComputePythonRuntimes(deps: SharedDependencies): void {
  for (const provider of computeAccountProviders) {
    owners.set(
      provider,
      new ComputePythonRuntime(
        {
          ...deps,
          getSelection: () => deps.getSelection(provider),
          saveSelection: (selection) => deps.saveSelection(provider, selection),
          commit: (operation) => deps.commit(provider, operation)
        },
        provider
      )
    )
  }
}
export function computePythonRuntime(provider: ComputeAccountProvider): ComputePythonRuntime {
  const owner = owners.get(provider)
  if (!owner) throw new ComputePythonError('dependency')
  return owner
}
