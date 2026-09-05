import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'

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
  'CONDA_ENVS_PATH',
  'MAMBA_ROOT_PREFIX',
  'HOME',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'R_USER',
  'R_LIBS_USER',
  'PYTHONNOUSERSITE',
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

const normalizeDarwinRepodataCachePermissions = (
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  platform: NodeJS.Platform
): void => {
  if (platform !== 'darwin') return
  const managedRoot = resolve(runtimeRoot)
  for (const packageRoot of (env.CONDA_PKGS_DIRS ?? '').split(delimiter)) {
    if (!isAbsolute(packageRoot)) continue
    const fromManagedRoot = relative(managedRoot, resolve(packageRoot))
    if (fromManagedRoot.startsWith('..') || isAbsolute(fromManagedRoot)) continue
    // The configured storage path may itself contain a symlink. Resolve that trusted
    // anchor once; links beneath it must never redirect this unsandboxed preparation.
    mkdirSync(managedRoot, { recursive: true })
    const physicalRoot = join(realpathSync(managedRoot), fromManagedRoot)
    const cache = join(physicalRoot, 'cache')
    // Node has no mkdirat: validate each parent before creation and recheck the
    // resulting physical path. Permission changes below are descriptor-bound.
    const ensureDirectory = (path: string): void => {
      try {
        const state = lstatSync(path)
        if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(path) !== path) {
          throw new Error(`Managed Micromamba repodata cache is not a trusted directory: ${path}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        ensureDirectory(dirname(path))
        mkdirSync(path, { mode: 0o755 })
        ensureDirectory(path)
      }
    }
    ensureDirectory(cache)
    const fd = openSync(cache, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const state = fstatSync(fd)
      const current = lstatSync(cache)
      if (
        !state.isDirectory() ||
        state.dev !== current.dev ||
        state.ino !== current.ino ||
        realpathSync(cache) !== cache
      ) {
        throw new Error(`Managed Micromamba repodata cache is not a trusted directory: ${cache}`)
      }
      // Micromamba can leave cache/ setgid. Seatbelt denies clearing that bit even
      // with file-write-mode, so repair it before entering the production sandbox.
      // Operate on the validated descriptor, never on a path that can be replaced.
      if ((state.mode & 0o2000) !== 0) fchmodSync(fd, state.mode & 0o5777)
      const after = lstatSync(cache)
      if (after.dev !== state.dev || after.ino !== state.ino || realpathSync(cache) !== cache) {
        throw new Error(`Managed Micromamba repodata cache changed during preparation: ${cache}`)
      }
    } finally {
      closeSync(fd)
    }
  }
}

/** Routes manage_packages workers through the same network/filesystem boundary as Notebook code. */
export const sandboxedPackageSpawn =
  (options: PackageProcessSandboxOptions): InstallSpawn =>
  async (command, args, env, onChild, onBeforeSpawn) => {
    const { processSandbox, request, runtimeRoot, storageRoot } = options
    const platform = options.platform ?? process.platform
    const projectedEnv = packageEnvironment(env ?? {}, platform)
    normalizeDarwinRepodataCachePermissions(projectedEnv, runtimeRoot, platform)
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
