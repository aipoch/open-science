import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

const absolutePath = z.string().refine(isAbsolute)
const associationSchema = z
  .object({
    schema: z.literal(1),
    wrapperPath: absolutePath,
    runtimePath: absolutePath,
    runtimeRoot: absolutePath,
    stateRoot: absolutePath
  })
  .strict()
export type MacOrdinaryEntry = z.infer<typeof associationSchema>
const entries = new Map<string, MacOrdinaryEntry>()
const faultInjectionEntries = new Set<string>()
const launcherRequirement =
  'identifier "com.aipoch.open-science.launcher" and anchor apple generic and certificate leaf[subject.OU] = "87G9WFU9H3"'

export function ordinaryEntrySigningRequirement(
  details: string,
  designated: string,
  configuration: Record<string, unknown>
): string {
  const lines = details.split('\n')
  if (lines.includes('TeamIdentifier=87G9WFU9H3')) return launcherRequirement
  if (
    lines.includes('Signature=adhoc') &&
    lines.includes('TeamIdentifier=not set') &&
    designated &&
    configuration.runtimeRequirement === designated &&
    configuration.faultInjection !== true
  )
    return 'identifier "com.aipoch.open-science.launcher"'
  throw new Error('The ordinary Mac entry publisher does not match the running runtime.')
}

function verifyOrdinaryPublisher(
  wrapper: string,
  runtime: string,
  configuration: Record<string, unknown>
): void {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', runtime], {
    timeout: 20_000,
    stdio: 'pipe'
  })
  const describe = (args: string[]): string => {
    const result = spawnSync('/usr/bin/codesign', args, { timeout: 20_000, encoding: 'utf8' })
    if (result.error || result.status !== 0)
      throw new Error('The Mac runtime signing identity is unavailable.')
    return result.stdout + result.stderr
  }
  const details = describe(['-d', '--verbose=4', runtime])
  const designated =
    describe(['-d', '-r-', runtime])
      .split('\n')
      .find((line) => line.startsWith('designated => '))
      ?.slice('designated => '.length) ?? ''
  const requirement = ordinaryEntrySigningRequirement(details, designated, configuration)
  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '-R', requirement, wrapper],
    { timeout: 20_000, stdio: 'pipe' }
  )
}

/** Squirrel launches its runtime without the source process environment. Read the persistent
 * wrapper association before selecting an update/profile record, without trusting an env path.
 * This deliberately stays synchronous so Electron cannot initialize a default profile first. */
export function loadMacOrdinaryEntry(
  runtimeBundle: string,
  verifyPublisher: (
    wrapper: string,
    runtime: string,
    configuration: Record<string, unknown>
  ) => void = verifyOrdinaryPublisher
): MacOrdinaryEntry | undefined {
  const path = join(dirname(resolve(runtimeBundle)), 'ordinary-entry.json')
  if (!existsSync(path)) return undefined
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('The ordinary Mac entry association is not a regular file.')
  const association = associationSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  const runtime = realpathSync(runtimeBundle)
  const wrapper = realpathSync(association.wrapperPath)
  const runtimeRoot = realpathSync(association.runtimeRoot)
  const stateRoot = realpathSync(association.stateRoot)
  const key = createHash('sha256').update(wrapper).digest('hex')
  if (
    association.runtimePath !== runtime ||
    association.wrapperPath !== wrapper ||
    association.runtimeRoot !== runtimeRoot ||
    association.stateRoot !== stateRoot ||
    join(runtimeRoot, key, 'Open-Science.app') !== runtime
  )
    throw new Error('The ordinary Mac entry does not belong to this runtime installation.')
  const configuration = JSON.parse(
    readFileSync(join(wrapper, 'Contents/Resources/mac-recovery-entry.json'), 'utf8')
  )
  // Both the ordinary entry and runtime identity are verified before trusting sealed settings.
  verifyPublisher(wrapper, runtime, configuration)
  if (
    configuration.schema !== 1 ||
    configuration.runtimeBundleIdentifier !== 'com.aipoch.open-science'
  )
    throw new Error('The ordinary Mac entry has an invalid runtime identity.')
  if (configuration.faultInjection === true) faultInjectionEntries.add(runtime)
  else faultInjectionEntries.delete(runtime)
  entries.set(runtime, association)
  return association
}

/** Only a previously verified startup association may redirect installation/Finder actions. */
export function ordinaryMacBundle(runtimeBundle: string): string {
  let canonical: string
  try {
    canonical = realpathSync(runtimeBundle)
  } catch {
    return runtimeBundle
  }
  return entries.get(canonical)?.wrapperPath ?? runtimeBundle
}

/** Only a sealed, publisher-verified diagnostic wrapper can enable native acceptance pauses. */
export function macEntryFaultInjectionEnabled(runtimeBundle: string): boolean {
  return faultInjectionEntries.has(realpathSync(runtimeBundle))
}
