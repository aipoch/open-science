export type DarwinProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  sid: number
  uniqueId: string
  parentUniqueId: string
}

export type DarwinProcessTable = {
  processes: DarwinProcessIdentity[]
  complete: boolean
}

export function getDarwinProcess(pid: number): DarwinProcessIdentity | null
export function getDarwinEnvironmentValue(pid: number, name: string): string | false | null
export function listDarwinProcesses(): DarwinProcessTable | null
