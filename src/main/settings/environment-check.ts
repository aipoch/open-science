import { arch as hostArchitecture } from 'node:os'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'

import type {
  AgentFrameworkId,
  ClaudeDetectResult,
  EnvironmentCheckItem,
  EnvironmentCheckResult,
  ManagedClaudeRegistry
} from '../../shared/settings'
import { findPythonCommand, type PythonCommand } from '../notebook/python-command'
import { getManagedPlatform } from './managed-claude'

const REGISTRY_URLS: Record<ManagedClaudeRegistry, string> = {
  npmjs: 'https://registry.npmjs.org',
  npmmirror: 'https://registry.npmmirror.com'
}

const REGISTRY_LABELS: Record<ManagedClaudeRegistry, string> = {
  npmjs: 'official npm registry',
  npmmirror: 'China-friendly npmmirror'
}

const REGISTRY_PROBE_PATH = '/@anthropic-ai%2fclaude-code/latest'
const REGISTRY_PROBE_TIMEOUT_MS = 5_000

type RegistryProbe = (registry: ManagedClaudeRegistry) => Promise<number>

export type EnvironmentCheckDeps = {
  platform?: NodeJS.Platform
  architecture?: string
  verifyStorage?: (storageRoot: string) => Promise<void>
  resolveManagedPlatform?: () => unknown
  findPython?: () => Promise<PythonCommand | undefined>
  probeRegistry?: RegistryProbe
  now?: () => number
}

const platformLabel = (platform: NodeJS.Platform): string => {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'

  return platform
}

// Writes and removes a uniquely-named sentinel inside the exact directory used by the managed
// runtime. This verifies the permission Open Science actually needs without requesting admin access
// or touching a system-owned installation directory.
const verifyStorageAccess = async (storageRoot: string): Promise<void> => {
  await mkdir(storageRoot, { recursive: true })
  const sentinel = join(
    storageRoot,
    `.environment-check-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )

  try {
    await writeFile(sentinel, 'open-science', { encoding: 'utf8', flag: 'wx' })
  } finally {
    await rm(sentinel, { force: true }).catch(() => undefined)
  }
}

// Uses the same direct HTTPS route as the managed downloader and follows a small number of redirects.
// A HEAD request keeps the required basic source check lightweight on every startup.
const probeRegistryReachability: RegistryProbe = (registry) => {
  const startedAt = Date.now()

  return new Promise<number>((resolve, reject) => {
    const visit = (url: string, redirectsLeft: number): void => {
      const request = httpsRequest(url, { method: 'HEAD' }, (response) => {
        const status = response.statusCode ?? 0

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects while checking ${registry}`))
            return
          }

          visit(new URL(response.headers.location, url).toString(), redirectsLeft - 1)
          return
        }

        response.resume()
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status} while checking ${registry}`))
          return
        }

        resolve(Date.now() - startedAt)
      })

      request.setTimeout(REGISTRY_PROBE_TIMEOUT_MS, () => {
        request.destroy(new Error(`Timed out while checking ${registry}`))
      })
      request.on('error', reject)
      request.end()
    }

    visit(`${REGISTRY_URLS[registry]}${REGISTRY_PROBE_PATH}`, 3)
  })
}

const inspectRegistry = async (
  registry: ManagedClaudeRegistry,
  probe: RegistryProbe
): Promise<{ registry: ManagedClaudeRegistry; latencyMs?: number }> => {
  try {
    return { registry, latencyMs: await probe(registry) }
  } catch {
    return { registry }
  }
}

const runEnvironmentCheck = async ({
  storageRoot,
  runtime,
  agentFrameworkId,
  frameworkLabel,
  encryptionAvailable,
  deps = {}
}: {
  storageRoot: string
  // Detection result for the SELECTED framework's runtime (Claude or OpenCode), in the shared shape.
  runtime: ClaudeDetectResult
  agentFrameworkId: AgentFrameworkId
  // Display name for the runtime check's copy ('Claude' / 'OpenCode').
  frameworkLabel: string
  encryptionAvailable: boolean
  deps?: EnvironmentCheckDeps
}): Promise<EnvironmentCheckResult> => {
  const platform = deps.platform ?? process.platform
  const architecture = deps.architecture ?? hostArchitecture()
  const verifyStorage = deps.verifyStorage ?? verifyStorageAccess
  const resolveManagedPlatform = deps.resolveManagedPlatform ?? (() => getManagedPlatform())
  const findPython = deps.findPython ?? findPythonCommand
  const probeRegistry = deps.probeRegistry ?? probeRegistryReachability
  const now = deps.now ?? Date.now

  const [systemCheck, storageCheck, python] = await Promise.all([
    Promise.resolve().then<EnvironmentCheckItem>(() => {
      try {
        resolveManagedPlatform()
        return {
          id: 'system',
          label: 'System compatibility',
          status: 'passed',
          summary: `${platformLabel(platform)} ${architecture} is supported.`,
          detail:
            'Automatic setup uses an app-managed runtime and does not require administrator access.'
        }
      } catch (error) {
        // An already-runnable runtime can still be used even if this architecture has no managed
        // package. Only a machine that also lacks the runtime is blocked from automatic setup.
        return {
          id: 'system',
          label: 'System compatibility',
          status: runtime.found ? 'warning' : 'failed',
          summary: runtime.found
            ? `${platformLabel(platform)} ${architecture} can use the detected ${frameworkLabel} runtime.`
            : `${platformLabel(platform)} ${architecture} has no automatic installer package.`,
          detail:
            error instanceof Error
              ? error.message
              : 'Use the manual setup tab to install a compatible Claude runtime.'
        }
      }
    }),
    verifyStorage(storageRoot)
      .then<EnvironmentCheckItem>(() => ({
        id: 'storage',
        label: 'App storage permission',
        status: 'passed',
        summary: 'Open Science can write to its private data folder.',
        detail: storageRoot
      }))
      .catch<EnvironmentCheckItem>((error) => ({
        id: 'storage',
        label: 'App storage permission',
        status: 'failed',
        summary: 'Open Science cannot write to its private data folder.',
        detail:
          error instanceof Error
            ? `${storageRoot} — ${error.message}`
            : `${storageRoot} — grant write access, then check again.`
      })),
    findPython().catch(() => undefined)
  ])

  let recommendedRegistry: ManagedClaudeRegistry | undefined
  let networkCheck: EnvironmentCheckItem

  if (runtime.found) {
    networkCheck = {
      id: 'install-network',
      label: 'Installation network',
      status: 'passed',
      summary: `No download is needed because ${frameworkLabel} is already installed.`
    }
  } else {
    const registryResults = await Promise.all([
      inspectRegistry('npmjs', probeRegistry),
      inspectRegistry('npmmirror', probeRegistry)
    ])
    const reachable = registryResults
      .filter(
        (result): result is { registry: ManagedClaudeRegistry; latencyMs: number } =>
          result.latencyMs !== undefined
      )
      .sort((left, right) => left.latencyMs - right.latencyMs)

    recommendedRegistry = reachable[0]?.registry
    networkCheck = recommendedRegistry
      ? {
          id: 'install-network',
          label: 'Installation network',
          status: 'passed',
          summary: `${REGISTRY_LABELS[recommendedRegistry]} is the fastest reachable source.`,
          detail: `Measured ${reachable[0].latencyMs} ms. The other trusted source remains available as an automatic fallback.`
        }
      : {
          id: 'install-network',
          label: 'Installation network',
          status: 'failed',
          summary: 'Neither the official registry nor the China-friendly mirror is reachable.',
          detail: 'Check the network, proxy, VPN, or firewall, then run the check again.'
        }
  }

  const secureStorageCheck: EnvironmentCheckItem = encryptionAvailable
    ? {
        id: 'secure-storage',
        label: 'Secure credential storage',
        status: 'passed',
        summary: 'The operating-system credential vault is available.'
      }
    : {
        id: 'secure-storage',
        label: 'Secure credential storage',
        status: 'warning',
        summary: 'The operating-system credential vault is unavailable.',
        detail:
          'Unlock or authorize the system keychain when possible. Setup can continue with reduced key protection.'
      }

  const pythonCheck: EnvironmentCheckItem = python
    ? {
        id: 'python',
        label: 'Python for Notebook',
        status: 'passed',
        summary: 'Python is available for the optional Notebook feature.',
        detail: [python.command, ...python.baseArgs].join(' ')
      }
    : {
        id: 'python',
        label: 'Python for Notebook',
        status: 'warning',
        summary: 'Python 3 was not found. Core setup can continue.',
        detail: 'Notebook execution will be unavailable until Python 3 is installed.'
      }

  const runtimeCheck: EnvironmentCheckItem = runtime.found
    ? {
        id: 'agent',
        label: `${frameworkLabel} runtime`,
        status: 'passed',
        summary: runtime.version
          ? `${frameworkLabel} ${runtime.version} is ready.`
          : `${frameworkLabel} is ready.`,
        detail: runtime.path
      }
    : {
        id: 'agent',
        label: `${frameworkLabel} runtime`,
        status: 'failed',
        summary: `${frameworkLabel} is not installed yet.`,
        detail:
          'Automatic setup installs a self-contained runtime without Node.js, npm, or admin access.'
      }

  const checks = [
    systemCheck,
    storageCheck,
    secureStorageCheck,
    networkCheck,
    pythonCheck,
    runtimeCheck
  ]
  const passedIds = new Set(
    checks.filter((check) => check.status === 'passed').map((check) => check.id)
  )

  return {
    checkedAt: now(),
    platform,
    architecture,
    checks,
    ready: checks.every((check) => check.status !== 'failed'),
    canAutoInstall:
      !runtime.found &&
      passedIds.has('system') &&
      passedIds.has('storage') &&
      passedIds.has('install-network'),
    recommendedRegistry,
    agentFrameworkId,
    runtime
  }
}

export { REGISTRY_URLS, probeRegistryReachability, runEnvironmentCheck, verifyStorageAccess }
