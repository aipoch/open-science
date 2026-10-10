import { runtimeMetadata } from '../runtime-metadata'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'

export type WindowsNotebookRuntime = Readonly<{
  root: string
  node: string
  powershell: string
}>

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

// Production resolves only a prepared, verified selection. The vendor path below is retained for
// source-build/native CI fixtures; arbitrary host runtimes are never a protected-mode fallback.
export const resolveWindowsNotebookRuntime = (
  resourcesPath: string | undefined = runtimeMetadata().resourcesPath,
  moduleDirectory: string = __dirname,
  architecture: string = process.arch
): WindowsNotebookRuntime => {
  if (preparedRuntime) return preparedRuntime()
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

export const windowsNotebookRuntimeEnvironment = (
  environment: NodeJS.ProcessEnv,
  runtime: WindowsNotebookRuntime
): NodeJS.ProcessEnv => {
  const env = { ...environment }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = [win32.dirname(runtime.node), env[pathKey]].filter(Boolean).join(';')
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
