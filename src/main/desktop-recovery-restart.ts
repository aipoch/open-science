import { z } from 'zod'
import { runtimeStartupOptionsSchema } from './runtime-startup-options'
import { serviceLifetimeRecordSchema, type ServiceLifetimeRecord } from './local-service-lifetime'
import { assertDesktopRuntimeRestartAllowed } from './desktop-runtime-recovery'

const ARGUMENT = '--open-science-recovery-launch='
const launchSchema = z
  .object({
    configuration: runtimeStartupOptionsSchema.pick({
      configRoot: true,
      profilePath: true,
      port: true,
      credentialStore: true,
      passwordStore: true
    }),
    // Older/unmarked arguments are recovery launches, including those with no reviewed stop.
    mode: z.literal('ordinary').optional(),
    authorization: serviceLifetimeRecordSchema.optional()
  })
  .strict()
export type DesktopRecoveryLaunch = z.infer<typeof launchSchema>

export function assertDesktopRecoveryLaunchAllowed(
  launch: DesktopRecoveryLaunch,
  intent: ServiceLifetimeRecord | undefined
): void {
  if (launch.mode !== 'ordinary')
    assertDesktopRuntimeRestartAllowed(intent, launch.authorization, false)
}

// Configuration and an exact reviewed stop only. Never transfer a credential inventory or
// a dataRoot snapshot: the successor reads current persisted configuration and fresh secrets.
export function readDesktopRecoveryLaunch(
  args: readonly string[]
): DesktopRecoveryLaunch | undefined {
  const values = args.filter((arg) => arg.startsWith(ARGUMENT))
  if (values.length === 0) return undefined
  if (values.length !== 1 || values[0].length > 32_768)
    throw new Error('Invalid desktop recovery launch configuration.')
  return launchSchema.parse(
    JSON.parse(Buffer.from(values[0].slice(ARGUMENT.length), 'base64url').toString('utf8'))
  )
}

export function desktopRecoveryRelaunchArgs(
  args: readonly string[],
  launch: DesktopRecoveryLaunch
): string[] {
  return [
    ...args.filter((arg) => !arg.startsWith(ARGUMENT)),
    ARGUMENT + Buffer.from(JSON.stringify(launchSchema.parse(launch))).toString('base64url')
  ]
}

/** Ordinary relaunches retain profile configuration, never a previous stop authorization. */
export function desktopOrdinaryRelaunchArgs(args: readonly string[]): string[] {
  const previous = readDesktopRecoveryLaunch(args)
  return previous
    ? desktopRecoveryRelaunchArgs(args, { configuration: previous.configuration, mode: 'ordinary' })
    : [...args]
}

/** Saving admits a normal quit; only its completed shutdown may schedule the successor. */
export function createDesktopRecoveryRestart(options: {
  prepare(): Promise<boolean>
  quit(): void
  relaunch(args: string[]): void
}): {
  request(args: string[] | (() => Promise<string[]>)): Promise<'blocked' | 'restarting'>
  cancel(): void
  isPending(): boolean
  beforeExit(): void
} {
  let epoch = 0
  let pending: Promise<'blocked' | 'restarting'> | undefined
  let launchArgs: string[] | undefined
  return {
    request(args) {
      if (pending) return pending
      if (launchArgs) return Promise.resolve('restarting')
      const observed = epoch
      pending = (async () => {
        try {
          const resolved = typeof args === 'function' ? await args() : args
          if (observed !== epoch || !(await options.prepare()) || observed !== epoch)
            return 'blocked'
          launchArgs = [...resolved]
          options.quit()
          return 'restarting'
        } catch {
          launchArgs = undefined
          return 'blocked'
        }
      })().finally(() => {
        pending = undefined
      })
      return pending
    },
    isPending() {
      return launchArgs !== undefined
    },
    cancel() {
      epoch++
      launchArgs = undefined
    },
    beforeExit() {
      if (!launchArgs) return
      const args = launchArgs
      launchArgs = undefined
      options.relaunch(args)
    }
  }
}
