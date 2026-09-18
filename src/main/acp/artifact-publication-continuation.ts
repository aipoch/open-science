import type { SessionNotification } from '@agentclientprotocol/sdk'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { isRecord } from '../value-guards'
import { toAcpRuntimeEvent } from './runtime-events'

const NOTEBOOK_MCP_SERVERS = ['open-science-notebook'] as const
const MAX_GENERATED_FILES = 20
const MAX_PAYLOAD_VALUES = 200

type NotebookWorkingFile = Readonly<{
  relativePath: string
  producerRunId?: string
}>

const safeRelativePath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const path = value.trim()
  if (
    !path ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[a-z]:[\\/]/iu.test(path) ||
    path.split(/[\\/]/u).includes('..') ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
    })
  ) {
    return undefined
  }
  return path
}

const safeRunId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const runId = value.trim()
  if (!runId || [...runId].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)) {
    return undefined
  }
  return runId
}

const parsedJson = (value: string): unknown => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

const workingFilesFrom = (roots: readonly unknown[]): NotebookWorkingFile[] => {
  const files = new Map<string, NotebookWorkingFile>()
  const pending = roots.map((value) => ({ value, inheritedRunId: undefined as string | undefined }))
  let visited = 0

  while (pending.length > 0 && visited < MAX_PAYLOAD_VALUES && files.size < MAX_GENERATED_FILES) {
    visited += 1
    const { value, inheritedRunId } = pending.pop()!
    if (typeof value === 'string') {
      const parsed = parsedJson(value)
      if (parsed !== undefined) pending.push({ value: parsed, inheritedRunId })
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, inheritedRunId })
      continue
    }
    if (!isRecord(value)) continue

    const runId = safeRunId(value.runId) ?? inheritedRunId
    if (Array.isArray(value.workingFiles)) {
      for (const candidate of value.workingFiles) {
        if (!isRecord(candidate)) continue
        const relativePath = safeRelativePath(candidate.relativePath)
        if (!relativePath) continue
        const producerRunId = safeRunId(candidate.createdByRunId) ?? runId
        files.set(relativePath, {
          relativePath,
          ...(producerRunId ? { producerRunId } : {})
        })
        if (files.size >= MAX_GENERATED_FILES) break
      }
    }

    for (const nested of Object.values(value)) {
      pending.push({ value: nested, inheritedRunId: runId })
    }
  }

  return [...files.values()]
}

class NotebookWorkingFileObserver {
  private readonly files = new Map<string, NotebookWorkingFile>()
  private readonly toolIdentityByCallId = new Map<string, string>()

  observe(notification: SessionNotification): void {
    const event = toAcpRuntimeEvent(notification, 'notebook-working-file-observation')
    if (event.kind !== 'tool') return
    const directIdentity = [event.providerToolName, event.title]
      .map((name) => resolveCanonicalMcpToolIdentity(name, NOTEBOOK_MCP_SERVERS))
      .find((name) => name?.startsWith('open-science-notebook/'))
    if (event.toolCallId && directIdentity) {
      this.toolIdentityByCallId.set(event.toolCallId, directIdentity)
    }
    const identity = directIdentity ?? this.toolIdentityByCallId.get(event.toolCallId ?? '')
    if (event.status === 'failed' && event.toolCallId) {
      this.toolIdentityByCallId.delete(event.toolCallId)
      return
    }
    if (!identity || event.status !== 'completed') return

    const roots = [event.rawOutput, ...(event.toolContent ?? [])]
    for (const file of workingFilesFrom(roots)) this.files.set(file.relativePath, file)
    if (event.toolCallId) this.toolIdentityByCallId.delete(event.toolCallId)
  }

  snapshot(): readonly NotebookWorkingFile[] {
    return Object.freeze([...this.files.values()])
  }
}

const artifactPublicationContinuationText = (
  files: readonly NotebookWorkingFile[],
  toolName: string
): string => {
  const requests = files.map(({ relativePath, producerRunId }) => ({
    filename: relativePath.split(/[\\/]/u).at(-1)!,
    source: { kind: 'localPath', path: relativePath },
    ...(producerRunId ? { producerRunId } : {})
  }))
  return [
    'The preceding Notebook execution created local files, but the turn ended before any Artifact was saved.',
    `Review the generated files below and call \`${toolName}\` now for each final user-facing output that should be delivered to the user. Do not publish caches or intermediate files.`,
    'Use the exact filename, source, and producerRunId values shown. Do not end the turn until the selected tool calls finish.',
    JSON.stringify(requests, null, 2)
  ].join('\n\n')
}

export { NotebookWorkingFileObserver, artifactPublicationContinuationText }
export type { NotebookWorkingFile }
