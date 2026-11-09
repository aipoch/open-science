import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'

export type WindowsNotebookRuntime = Readonly<{
  root: string
  node: string
  powershell: string
}>

export type WindowsNotebookNodeRuntime = Readonly<Pick<WindowsNotebookRuntime, 'root' | 'node'>>

let preparedRuntime: (() => WindowsNotebookRuntime) | undefined

// Installed by the application composition root; preparation remains asynchronous and explicit.
// Tests and source-build CI without composition retain the isolated vendor fixture resolver.
export const configureWindowsNotebookRuntime = (
  resolver: () => WindowsNotebookRuntime
): (() => void) => {
  preparedRuntime = resolver
  return () => {
    if (preparedRuntime === resolver) preparedRuntime = undefined
  }
}

const resolvePackagedWindowsNotebookRuntime = (
  resourcesPath: string | undefined = runtimeMetadataIfConfigured()?.resourcesPath,
  moduleDirectory: string = __dirname,
  architecture: string = process.arch
): WindowsNotebookRuntime => {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error(`Windows Notebook runtime does not support ${architecture}.`)
  }
  const relative = `packages/notebook-network-sandbox/vendor/windows-runtime/${architecture}`
  const packagedRoot = resourcesPath && join(resourcesPath, 'notebook-runtime', architecture)
  const candidates =
    resourcesPath && existsSync(join(resourcesPath, 'app.asar'))
      ? [packagedRoot!]
      : [
          packagedRoot,
          join(moduleDirectory, '../..', relative),
          join(moduleDirectory, '../../..', relative)
        ]
  for (const root of candidates) {
    if (!root) continue
    const node = join(root, 'node', 'node.exe')
    const powershell = join(root, 'powershell', 'pwsh.exe')
    if (existsSync(node) && existsSync(powershell) && existsSync(join(root, 'build.json'))) {
      return Object.freeze({ root, node, powershell })
    }
  }
  throw new Error(
    'Windows Notebook runtime is missing. Build the bundled Windows runtime before starting Notebook execution.'
  )
}

const resolvePackagedWindowsNotebookNodeRuntime = (
  resourcesPath: string | undefined = runtimeMetadataIfConfigured()?.resourcesPath,
  moduleDirectory: string = __dirname,
  architecture: string = process.arch
): WindowsNotebookNodeRuntime => {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error(`Windows Notebook runtime does not support ${architecture}.`)
  }
  const relative = `out/node-runtime/win32-${architecture}`
  const vendorRelative = `packages/notebook-network-sandbox/vendor/windows-runtime/${architecture}/node`
  const hostResourcesPath = process.env.OPEN_SCIENCE_RESOURCES_PATH
  const resourcePaths = [...new Set([resourcesPath, hostResourcesPath].filter(Boolean))] as string[]
  const packagedRoot = resourcesPath && join(resourcesPath, 'node-runtime')
  const hostPackagedRoot = hostResourcesPath && join(hostResourcesPath, 'node-runtime')
  const packagedResourcePath = resourcePaths.find((path) => existsSync(join(path, 'app.asar')))
  const candidates = packagedResourcePath
    ? [join(packagedResourcePath, 'node-runtime')]
    : [
        packagedRoot,
        hostPackagedRoot,
        // Standalone archives keep node-runtime beside backend/, while this module runs from
        // backend/out/backend.
        join(moduleDirectory, '../../../node-runtime'),
        join(moduleDirectory, '../..', relative),
        join(moduleDirectory, '../../..', relative),
        // Source-only fixtures are produced by the Windows runtime preparation workflow. They
        // keep clean Windows shell tests runnable without making packaged standard mode depend
        // on the protected runtime tree.
        join(moduleDirectory, '../..', vendorRelative),
        join(moduleDirectory, '../../..', vendorRelative)
      ]
  for (const root of candidates) {
    if (!root) continue
    const files = ['node.exe', 'npm.cmd', 'npx.cmd', 'node_modules/npm/package.json']
    if (files.every((file) => existsSync(join(root, file)))) {
      return Object.freeze({ root, node: join(root, 'node.exe') })
    }
  }
  throw new Error(
    'Windows Notebook Node runtime is missing. Build the bundled Node runtime before starting Notebook execution.'
  )
}

// Production resolves only a prepared, verified selection. The vendor path below is retained for
// source-build/native CI fixtures; arbitrary host runtimes are never a protected-mode fallback.
export const resolveWindowsNotebookRuntime = (
  resourcesPath: string | undefined = runtimeMetadataIfConfigured()?.resourcesPath,
  moduleDirectory: string = __dirname,
  architecture: string = process.arch
): WindowsNotebookRuntime =>
  preparedRuntime?.() ??
  resolvePackagedWindowsNotebookRuntime(resourcesPath, moduleDirectory, architecture)

// Ordinary Windows PowerShell does not enable protected runtime preparation, but shell tasks still
// need the shipped Node/npm pair. Resolve only the immutable packaged/development files here; the
// protected path above remains owned by the verified runtime manager.
export const resolveWindowsNotebookNodeRuntime = (
  resourcesPath: string | undefined = runtimeMetadataIfConfigured()?.resourcesPath,
  moduleDirectory: string = __dirname,
  architecture: string = process.arch
): WindowsNotebookNodeRuntime => {
  return resolvePackagedWindowsNotebookNodeRuntime(resourcesPath, moduleDirectory, architecture)
}

export const windowsNotebookNodeEnvironment = (
  environment: NodeJS.ProcessEnv,
  runtime: WindowsNotebookNodeRuntime
): NodeJS.ProcessEnv => {
  const env = { ...environment }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const nodeDirectory = win32.dirname(runtime.node)
  const existingPath = env[pathKey]
    ?.split(';')
    .filter((entry) => entry && entry.toLowerCase() !== nodeDirectory.toLowerCase())
  env[pathKey] = [nodeDirectory, ...(existingPath ?? [])].join(';')
  return env
}

export const windowsNotebookRuntimeEnvironment = (
  environment: NodeJS.ProcessEnv,
  runtime: WindowsNotebookRuntime
): NodeJS.ProcessEnv => {
  const env = windowsNotebookNodeEnvironment(environment, runtime)
  // The module loader's realpath walk requires metadata on ungranted ancestors. Keep module
  // paths as supplied, including npm entry points and descendant Node processes, without ACLs
  // on those ancestors. Do not inherit host NODE_OPTIONS (which may preload arbitrary code).
  env.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
  // Keep PowerShell 5.1 modules out of the bundled Core runtime's automatic module discovery.
  const modulePath = win32.join(win32.dirname(runtime.powershell), 'Modules')
  env.PSModulePath = modulePath
  env.OPEN_SCIENCE_PSMODULEPATH = modulePath
  return env
}
