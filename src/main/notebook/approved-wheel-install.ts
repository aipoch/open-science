import { mkdir, lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { devNull } from 'node:os'
import type { InstallResult, SpawnResult } from './package-manager'

export type WheelInstallPlan = {
  kind: 'package-installation'
  installer: 'pip'
  installed?: unknown
  packages: Array<{
    name: string
    version: string
    url: string
    sha256: string
    requested: boolean
  }>
}
export type ApproveWheelInstall = (plan: WheelInstallPlan) => Promise<boolean>

/** A solver report is data, never installer arguments. Accept only exact, hashed HTTPS wheels. */
export function parseWheelInstallPlan(report: unknown): WheelInstallPlan {
  const value = report as { version?: unknown; install?: unknown }
  if (value?.version !== '1' || !Array.isArray(value.install))
    throw new Error('Unsupported pip report.')
  const names = new Set<string>()
  const packages = value.install.map((entry) => {
    const { metadata, download_info: download, requested } = entry ?? {}
    if (
      typeof metadata?.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(metadata.name) ||
      typeof metadata?.version !== 'string' ||
      typeof download?.url !== 'string'
    ) {
      throw new Error('Incomplete package installation plan.')
    }
    const url = new URL(download.url)
    const sha256 = download.archive_info?.hashes?.sha256
    const normalized = metadata.name.toLowerCase().replace(/[-_.]+/g, '-')
    if (
      names.has(normalized) ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !url.pathname.toLowerCase().endsWith('.whl') ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      throw new Error(
        'Installation requires unique, SHA-256 pinned HTTPS wheels without credentials.'
      )
    }
    names.add(normalized)
    return {
      name: metadata.name,
      version: metadata.version,
      url: url.href,
      sha256,
      requested: requested === true
    }
  })
  return { kind: 'package-installation', installer: 'pip', packages }
}

export async function installApprovedWheels(options: {
  cacheRoot: string
  packages: string[]
  index?: string
  run: (args: string[], env: { PIP_CONFIG_FILE: string }) => Promise<SpawnResult>
  approve: ApproveWheelInstall
  signal?: AbortSignal
}): Promise<InstallResult> {
  // Source trees, direct URLs, editable installs and option-like specs can execute during solving.
  // Keep this initial supported path deliberately narrower than the legacy pip installer.
  if (
    options.packages.some(
      (spec) => !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:==[A-Za-z0-9][A-Za-z0-9.!+_-]*)?$/.test(spec)
    )
  ) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      error: 'Auto installation supports wheel package names and exact version pins only.'
    }
  }
  await mkdir(options.cacheRoot, { recursive: true, mode: 0o700 })
  if (
    !(await lstat(options.cacheRoot)).isDirectory() ||
    (await lstat(options.cacheRoot)).isSymbolicLink()
  )
    throw new Error('Installation plan storage must be an app-owned directory.')
  const directory = await mkdtemp(join(options.cacheRoot, 'package-plan-'))
  try {
    const reportPath = join(directory, 'report.json')
    const solved = await options.run(
      [
        '--isolated',
        '--disable-pip-version-check',
        '--no-input',
        'install',
        '--only-binary=:all:',
        '--dry-run',
        '--report',
        reportPath,
        ...(options.index ? ['--index-url', options.index] : []),
        ...options.packages
      ],
      { PIP_CONFIG_FILE: devNull }
    )
    if (solved.code !== 0)
      return {
        ok: false,
        needsRestart: false,
        log: solved.stdout + solved.stderr,
        error: 'Could not resolve a wheel-only installation plan; no fallback was run.'
      }
    if ((await stat(reportPath)).size > 4 * 1024 * 1024)
      throw new Error('Installation plan is too large.')
    const plan = parseWheelInstallPlan(JSON.parse(await readFile(reportPath, 'utf8')))
    if (!plan.packages.length)
      return {
        ok: true,
        needsRestart: false,
        log: 'Requested packages are already installed.',
        method: 'pip'
      }
    if (!(await options.approve(structuredClone(plan))))
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error: 'Installation plan was not approved.'
      }
    options.signal?.throwIfAborted()
    // No second solver or dependency fallback: only the reviewed artifacts, each hash-verified by pip.
    const result = await options.run(
      [
        '--isolated',
        '--disable-pip-version-check',
        '--no-input',
        'install',
        '--no-deps',
        '--only-binary=:all:',
        ...plan.packages.map((pkg) => `${pkg.url}#sha256=${pkg.sha256}`)
      ],
      { PIP_CONFIG_FILE: devNull }
    )
    return {
      ok: result.code === 0,
      needsRestart: false,
      method: 'pip',
      fallbackUsed: false,
      log: result.stdout + result.stderr,
      ...(result.code !== 0
        ? { error: 'Approved wheel installation failed; inspect package state before retrying.' }
        : {})
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
