import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type ProcessKind = 'agent' | 'electron' | 'node' | 'other' | 'python' | 'r' | 'shell'

type ProcessSnapshotEntry = {
  cumulativeCpuSeconds: number
  kind: ProcessKind
  parentPid: number
  pid: number
  rssKb: number
}

type ProcessTableSnapshot = {
  complete: boolean
  processes: ProcessSnapshotEntry[]
}

type ProcessTreeSnapshot = ProcessTableSnapshot & {
  rootPid: number
}

type CommandRunner = (command: string, args: readonly string[]) => Promise<string>

const runCommand: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return stdout
}

const classifyProcessName = (value: string): ProcessKind => {
  const name = value.replaceAll('\\', '/').split('/').at(-1)?.trim().toLowerCase() ?? ''
  if (/^(?:open science(?: \(dev\))?|electron)(?: helper.*)?(?:\.exe)?$/u.test(name)) {
    return 'electron'
  }
  if (/(?:^|[-_.])(claude|codex|opencode)(?:$|[-_.])/u.test(name)) return 'agent'
  if (/^(node|nodejs)(?:\.exe)?$/u.test(name)) return 'node'
  if (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(name)) return 'python'
  if (/^(r|rscript)(?:\.exe)?$/u.test(name)) return 'r'
  if (/^(?:ba|z|c|k|fi)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/u.test(name)) {
    return 'shell'
  }
  return 'other'
}

const parseCpuTimeSeconds = (value: string): number | undefined => {
  const [dayText, clockText] = value.includes('-') ? value.split('-', 2) : [undefined, value]
  const clockParts = clockText.split(':').map(Number)
  if (
    clockParts.length < 1 ||
    clockParts.length > 3 ||
    clockParts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return undefined
  }

  const days = dayText === undefined ? 0 : Number(dayText)
  if (!Number.isFinite(days) || days < 0) return undefined

  const seconds = clockParts.at(-1) ?? 0
  const minutes = clockParts.length >= 2 ? (clockParts.at(-2) ?? 0) : 0
  const hours = clockParts.length === 3 ? (clockParts.at(-3) ?? 0) : 0
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

const parsePosixProcessTable = (output: string): ProcessSnapshotEntry[] => {
  const processes: ProcessSnapshotEntry[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const rssKb = Number(match[3])
    const cumulativeCpuSeconds = parseCpuTimeSeconds(match[4])
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(rssKb) ||
      rssKb < 0 ||
      cumulativeCpuSeconds === undefined
    ) {
      continue
    }
    processes.push({
      pid,
      parentPid,
      rssKb,
      cumulativeCpuSeconds,
      kind: classifyProcessName(match[5])
    })
  }
  return processes
}

type WindowsProcessRecord = {
  KernelModeTime?: number | string
  Name?: string
  ParentProcessId?: number | string
  ProcessId?: number | string
  UserModeTime?: number | string
  WorkingSetSize?: number | string
}

const parseWindowsProcessTable = (output: string): ProcessSnapshotEntry[] => {
  const trimmed = output.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as WindowsProcessRecord | WindowsProcessRecord[]
  const records = Array.isArray(parsed) ? parsed : [parsed]
  const processes: ProcessSnapshotEntry[] = []
  for (const record of records) {
    const pid = Number(record.ProcessId)
    const parentPid = Number(record.ParentProcessId)
    const workingSetBytes = Number(record.WorkingSetSize)
    const kernelTicks = Number(record.KernelModeTime)
    const userTicks = Number(record.UserModeTime)
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isFinite(workingSetBytes) ||
      workingSetBytes < 0 ||
      !Number.isFinite(kernelTicks) ||
      kernelTicks < 0 ||
      !Number.isFinite(userTicks) ||
      userTicks < 0
    ) {
      continue
    }
    processes.push({
      pid,
      parentPid,
      rssKb: Math.round(workingSetBytes / 1024),
      cumulativeCpuSeconds: (kernelTicks + userTicks) / 10_000_000,
      kind: classifyProcessName(record.Name ?? '')
    })
  }
  return processes
}

const selectProcessTree = (
  processes: readonly ProcessSnapshotEntry[],
  rootPid: number
): ProcessSnapshotEntry[] => {
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  const childrenByParent = new Map<number, ProcessSnapshotEntry[]>()
  for (const process of processes) {
    const children = childrenByParent.get(process.parentPid) ?? []
    children.push(process)
    childrenByParent.set(process.parentPid, children)
  }

  const selected: ProcessSnapshotEntry[] = []
  const visited = new Set<number>()
  const pending = [rootPid]
  while (pending.length > 0) {
    const pid = pending.pop() as number
    if (visited.has(pid)) continue
    visited.add(pid)
    const process = byPid.get(pid)
    if (process) selected.push(process)
    for (const child of childrenByParent.get(pid) ?? []) pending.push(child.pid)
  }
  return selected.sort((left, right) => left.pid - right.pid)
}

const readProcessTable = async (
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = runCommand
): Promise<ProcessTableSnapshot> => {
  try {
    if (platform === 'win32') {
      const output = await runner('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name | ConvertTo-Json -Compress'
      ])
      return { complete: true, processes: parseWindowsProcessTable(output) }
    }

    const output = await runner('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,comm='])
    return { complete: true, processes: parsePosixProcessTable(output) }
  } catch {
    return { complete: false, processes: [] }
  }
}

const readProcessTree = async (
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = runCommand
): Promise<ProcessTreeSnapshot> => {
  const table = await readProcessTable(platform, runner)
  const processes = selectProcessTree(table.processes, rootPid)
  return {
    rootPid,
    processes,
    complete: table.complete && processes.some((process) => process.pid === rootPid)
  }
}

export {
  classifyProcessName,
  parseCpuTimeSeconds,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  readProcessTable,
  readProcessTree,
  selectProcessTree
}
export type {
  CommandRunner,
  ProcessKind,
  ProcessSnapshotEntry,
  ProcessTableSnapshot,
  ProcessTreeSnapshot
}
