export function requestExistingRuntimeWeb(
  options: { configRoot?: string; port?: number; credentialStore?: 'os' | 'file' },
  fetch?: typeof globalThis.fetch
): Promise<string | undefined>

export type ServiceProcessIdentity = {
  configRoot: string
  pid: number
  generation: string
  serviceGeneration: string
  birthToken?: string
  version: string
}

export function verifyServiceConfigRoot(requested: string, actual: unknown): Promise<void>
export function waitForServiceStopped(
  service: {
    pid: number
    generation: string
    lifetime: { generation: string }
    identity: ServiceProcessIdentity
  },
  options: {
    isAlive(pid: number): boolean
    now(): number
    sleep(milliseconds: number): Promise<unknown>
    timeoutMs: number
    readBirth?(identity: ServiceProcessIdentity, timeoutMs: number): Promise<string | undefined>
    readOwner?(configRoot: string): Promise<string>
  }
): Promise<{ stopped: true } | { stopped: false; reason: string }>

export function requestServiceLifetime(
  configRoot: string,
  operation?: 'status' | 'start' | 'stop' | 'force-stop',
  fetch?: typeof globalThis.fetch
): Promise<
  | {
      generation: string
      pid: number
      identity: ServiceProcessIdentity
      lifetime: {
        version: 1
        generation: string
        explicit: boolean
        stopping: boolean
        apps: number
        reason?: 'app-exit' | 'disconnect' | 'user-stop' | 'restart' | 'update'
      }
    }
  | undefined
>
