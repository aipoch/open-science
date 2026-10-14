/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const TAIL_BYTES = 32 * 1024
const readTail = async (path) => {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - TAIL_BYTES))
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

const processTable = () =>
  new Promise((resolveTable) => {
    // No command arguments or environment: they may contain credentials.
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,stat=,etime=,comm='],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolveTable(error ? '(process table unavailable)' : stdout)
    )
  })

export const selectSmokeProcesses = (table, pid) => {
  if (table === '(process table unavailable)') return table
  const rows = table
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+/)
      return match ? { pid: Number(match[1]), parent: Number(match[2]), line } : undefined
    })
    .filter(Boolean)
  const owned = new Set([pid])
  let previousSize
  do {
    previousSize = owned.size
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
  } while (owned.size !== previousSize)
  return (
    rows
      .filter((row) => owned.has(row.pid))
      .map((row) => row.line)
      .join('\n') || '(PID and descendants absent from process table)'
  )
}

export const collectSmokeDiagnostics = async (
  { configRoot, pid, desktop = false },
  { getProcessTable = processTable } = {}
) => {
  const sections = []
  try {
    if (Number.isSafeInteger(pid) && pid > 0) {
      sections.push(
        `Process snapshot (PID PPID STAT ELAPSED COMMAND):\n${selectSmokeProcesses(await getProcessTable(), pid)}`
      )
      if (process.platform === 'linux') {
        for (const name of ['stat', 'wchan']) {
          sections.push(
            `/proc/${pid}/${name}: ${await readFile(`/proc/${pid}/${name}`, 'utf8').catch(() => '(unavailable)')}`
          )
        }
      }
    }
    const logRoot = desktop ? join(configRoot, 'logs') : configRoot
    const pattern = desktop
      ? new RegExp(`^desktop-backend-${pid}-\\d+\\.log$`)
      : /^cli-daemon.*\.log$/
    const entries = (await readdir(logRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(-4)
    for (const name of entries) {
      sections.push(
        `${name} (last ${TAIL_BYTES} bytes):\n${await readTail(join(logRoot, name)).catch(() => '(unavailable)')}`
      )
    }
    if (entries.length === 0) sections.push('(backend logs unavailable)')
  } catch (error) {
    sections.push(`Diagnostics unavailable: ${error.code ?? error.name}`)
  }
  const token = await readFile(join(configRoot, 'web-token'), 'utf8')
    .then((text) => text.trim())
    .catch(() => '')
  const diagnostic = sections.join('\n')
  return token ? diagnostic.replaceAll(token, '<REDACTED>') : diagnostic
}
