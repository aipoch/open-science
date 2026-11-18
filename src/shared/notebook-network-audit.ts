import type { NotebookNetworkMode } from './notebook-network-settings'

export type NotebookNetworkAuditData = {
  eventId?: string
  requestId: string
  mode: NotebookNetworkMode
  projectId: string
  projectName?: string
  sessionId: string
  sessionNumber?: number
  notebookRunId?: string
  executionId?: string
  runtime: string
  host: string
  port: number
  protocol: 'http' | 'https'
  address?: string
  decision?: 'allowed' | 'blocked'
  reason?: string
  outcome?: 'connected' | 'completed' | 'failed' | 'cancelled' | 'timeout'
  statusCode?: number
  durationMs?: number
}
export type NotebookNetworkAuditRecord = {
  t: string
  level: 'info' | 'warn'
  scope: 'notebook:network'
  msg: 'network access'
  data: NotebookNetworkAuditData
}
export type NotebookNetworkAuditQuery = {
  mode?: NotebookNetworkMode
  projectId?: string
  sessionId?: string
  notebookRunId?: string
  address?: string
  decision?: 'allowed' | 'blocked'
  outcome?: NotebookNetworkAuditData['outcome']
  from?: number
  to?: number
  cursor?: string
  limit?: number
}
export type NotebookNetworkAuditPage = {
  records: NotebookNetworkAuditRecord[]
  cursor?: string
  warnings: string[]
  retentionDays: number
}
