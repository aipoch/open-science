import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { notebookNetworkAudit } from '../notebook/network-audit'
import type { DiagnosticTarget } from '../../shared/session-diagnostics'
import type { NotebookNetworkAuditRecord } from '../../shared/notebook-network-audit'

export async function inspectNetworkJournal(
  configRoot: string
): Promise<{ available: boolean; reason?: string }> {
  try {
    for (const path of [join(configRoot, 'logs'), join(configRoot, 'logs/network')])
      if (!(await lstat(path)).isDirectory()) throw new Error('Invalid directory')
    const files = await readdir(join(configRoot, 'logs/network'))
    return files.some((name) => /^notebook-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      ? { available: true }
      : { available: false, reason: 'Network records are unavailable or have expired.' }
  } catch {
    return { available: false, reason: 'Network records are unavailable or have expired.' }
  }
}

export async function collectNetworkJournal(
  configRoot: string,
  target: DiagnosticTarget
): Promise<{
  records: NotebookNetworkAuditRecord[]
  truncated: boolean
  warnings: string[]
}> {
  const records: NotebookNetworkAuditRecord[] = [],
    warnings = new Set<string>()
  let cursor: string | undefined,
    bytes = 0
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await notebookNetworkAudit(configRoot).query({
      ...(target.scope === 'application'
        ? {}
        : { projectId: target.projectId, sessionId: target.sessionId }),
      limit: 200,
      cursor
    })
    for (const warning of page.warnings) warnings.add(warning)
    for (const record of page.records) {
      bytes += Buffer.byteLength(JSON.stringify(record))
      if (bytes > 2 * 1024 * 1024) return { records, truncated: true, warnings: [...warnings] }
      records.push(record)
    }
    if (!page.cursor) return { records, truncated: false, warnings: [...warnings] }
    cursor = page.cursor
  }
  return { records, truncated: true, warnings: [...warnings] }
}
