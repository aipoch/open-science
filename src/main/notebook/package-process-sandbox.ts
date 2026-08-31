import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, win32 } from 'node:path'

import { defaultSpawn, type InstallRequest, type InstallSpawn } from './package-manager'
import { buildNotebookKernelEnvironment } from './process-environment'
import type { NotebookProcessSandbox } from './process-sandbox'

type PackageProcessSandboxOptions = Readonly<{
  processSandbox: NotebookProcessSandbox
  request: InstallRequest
  runtimeRoot: string
  storageRoot: string
  interpreter?: Readonly<{ command: string; condaPrefix?: string }>
  platform?: NodeJS.Platform
}>

const PACKAGE_ENV_KEYS = [
  'CONDA_PKGS_DIRS',
  'MAMBA_ROOT_PREFIX',
  'CONDA_SSL_VERIFY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'CURL_CA_BUNDLE',
  'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR',
  'PIP_CACHE_DIR',
  'UV_CACHE_DIR',
  'HF_HUB_CACHE',
  'HF_DATASETS_CACHE',
  'HF_XET_CACHE',
  'HF_ASSETS_CACHE',
  'TORCH_HOME',
  'TORCHINDUCTOR_CACHE_DIR',
  'TORCH_EXTENSIONS_DIR',
  'PYTORCH_KERNEL_CACHE_PATH',
  'TRITON_CACHE_DIR',
  'NUMBA_CACHE_DIR',
  'MPLCONFIGDIR',
  'R_USER_CACHE_DIR'
] as const

const PACKAGE_WRITE_PATH_KEYS = [
  'CONDA_PKGS_DIRS',
  'MAMBA_ROOT_PREFIX',
  'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR'
] as const

const packageEnvironment = (
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv => {
  const env = buildNotebookKernelEnvironment(platform, source)
  for (const key of PACKAGE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return env
}

const externalEnvironmentRoot = (
  interpreter: PackageProcessSandboxOptions['interpreter']
): string | undefined => {
  if (!interpreter) return undefined
  if (interpreter.condaPrefix && isAbsolute(interpreter.condaPrefix)) return interpreter.condaPrefix
  if (!isAbsolute(interpreter.command)) return undefined
  return dirname(dirname(interpreter.command))
}

const absolutePath = (value: string | undefined): string[] =>
  value && isAbsolute(value) ? [value] : []

const packageWriteRoots = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  const separator = platform === 'win32' ? win32.delimiter : delimiter
  return PACKAGE_WRITE_PATH_KEYS.flatMap((key) =>
    (env[key] ?? '')
      .split(separator)
      .map((path) => path.trim())
      .filter((path) => (platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)))
      .filter(existsSync)
  )
}

/** Routes manage_packages workers through the same network/filesystem boundary as Notebook code. */
export const sandboxedPackageSpawn =
  (options: PackageProcessSandboxOptions): InstallSpawn =>
  async (command, args, env, onChild, onBeforeSpawn) => {
    const { processSandbox, request, runtimeRoot, storageRoot } = options
    const platform = options.platform ?? process.platform
    const projectedEnv = packageEnvironment(env ?? {}, platform)
    const cwd =
      request.workspaceCwd && isAbsolute(request.workspaceCwd) ? request.workspaceCwd : storageRoot
    const sandboxed = await processSandbox.wrap({
      executable: command,
      args,
      env: projectedEnv,
      cwd,
      commandText: JSON.stringify([command, ...args]),
      sessionId: request.sessionId ?? 'notebook-package-manager',
      projectId: request.projectId ?? 'notebook-package-manager',
      runtime: request.language,
      filesystem: {
        readOnlyRoots: [...absolutePath(dirname(command)), ...absolutePath(request.workspaceCwd)],
        readWriteRoots: [
          runtimeRoot,
          ...absolutePath(externalEnvironmentRoot(options.interpreter)),
          ...packageWriteRoots(projectedEnv, platform)
        ],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    const endExecution = sandboxed.beginExecution?.()
    let ended = false
    try {
      const result = await defaultSpawn(
        sandboxed.executable,
        [...sandboxed.args],
        sandboxed.env,
        onChild,
        onBeforeSpawn,
        args.includes('--json'),
        cwd
      )
      endExecution?.()
      ended = true
      return { ...result, stderr: sandboxed.annotateStderr(result.stderr) }
    } finally {
      if (!ended) endExecution?.()
      sandboxed.cleanup()
    }
  }
