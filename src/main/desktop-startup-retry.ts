import { z } from 'zod'
import { serviceLifetimeRecordSchema } from './local-service-lifetime'
import { runtimeStartupOptionsSchema } from './runtime-startup-options'

const argumentPrefix = '--desktop-startup-retry='
// Data location remains owned by the configuration root. Carry only launch inputs, not secrets
// or the expiring credential inventory; the successor captures that before opening Chromium.
const retrySchema = z
  .object({
    options: runtimeStartupOptionsSchema.omit({ dataRoot: true }),
    // Configuration survives ordinary relaunches; stop authorization belongs only to recovery.
    restart: z.object({ stop: serviceLifetimeRecordSchema.optional() }).strict().optional()
  })
  .strict()
export type DesktopStartupRetry = z.infer<typeof retrySchema>

/** This request unwinds repair before it can spawn Node against an open Chromium profile. */
export class DesktopStartupRelaunch extends Error {
  constructor(readonly retry: DesktopStartupRetry) {
    super('Restart Desktop to refresh startup credentials.')
  }
}

/** Consume from JS argv; later ordinary relaunches must explicitly pass that cleaned argv. */
export function consumeDesktopStartupRetry(args: string[]): DesktopStartupRetry | undefined {
  const values = args.filter((arg) => arg.startsWith(argumentPrefix))
  if (!values.length) return undefined
  if (values.length !== 1) throw new Error('Duplicate desktop startup retry argument.')
  const retry = retrySchema.parse(
    JSON.parse(Buffer.from(values[0].slice(argumentPrefix.length), 'base64url').toString('utf8'))
  )
  args.splice(0, args.length, ...args.filter((arg) => !arg.startsWith(argumentPrefix)))
  return retry
}

export function desktopStartupRetryArgs(args: string[], retry: DesktopStartupRetry): string[] {
  return [
    ...args.filter((arg) => !arg.startsWith(argumentPrefix)),
    argumentPrefix + Buffer.from(JSON.stringify(retrySchema.parse(retry))).toString('base64url')
  ]
}
