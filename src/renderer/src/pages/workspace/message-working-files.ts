import type { ChatSession, ToolActivity } from '@/stores/session-store-contract'
import { resolveLocalPath } from '../../../../shared/local-fs'
import type { MessageArtifact } from './session-message-artifact-reference'

type ToolFileEvidence = {
  title?: string
  providerToolName?: string
  toolKind?: string
  toolLocations?: readonly { path: string }[]
  rawInput?: unknown
}

const recordedToolFilePaths = (tool: ToolFileEvidence): string[] => {
  const name = tool.providerToolName ?? tool.title ?? ''
  const writes =
    tool.toolKind === 'edit' ||
    /(?:^|[_/.-])(?:write|edit|create|apply_patch)(?:[_/.-]|$)/iu.test(name)
  const reads = tool.toolKind === 'read' || /(?:^|[_/.-])read(?:[_/.-]|$)/iu.test(name)
  if (!writes && !reads) return []
  const paths = (tool.toolLocations ?? []).map(({ path }) => path)
  if (tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput)) {
    const input = tool.rawInput as Record<string, unknown>
    const path = input.file_path ?? input.filePath ?? input.path
    if (typeof path === 'string') paths.push(path)
  }
  return [...new Set(paths)]
}

const absolutePath = (path: string): boolean => /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(path)
const safePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  }) &&
  !value.split(/[\\/]/u).includes('..')

// Only recorded file locations count as evidence. Never parse filenames out of prose or code,
// search the filesystem by basename, or borrow a later turn's tool calls.
const recordedWorkingFiles = (
  activities: readonly ToolActivity[],
  cwd: string,
  notebookRoot?: string
): MessageArtifact[] => {
  const files = new Map<string, MessageArtifact>()
  const add = (value: unknown, root: string | undefined, referencePath?: string): void => {
    if (!safePath(value) || (!absolutePath(value) && !root)) return
    const platform = /^[a-z]:[\\/]|^\\\\/iu.test(root ?? value) ? 'win32' : 'linux'
    const path = absolutePath(value)
      ? value
      : resolveLocalPath(
          root!,
          value.replace(/[\\/]/gu, platform === 'win32' ? '\\' : '/'),
          platform
        )
    files.set(path.replace(/\\/gu, '/'), {
      id: `working:${path}`,
      kind: 'workspace-file',
      path,
      name: path.split(/[\\/]/u).at(-1),
      referencePath: referencePath ?? value
    })
  }
  for (const activity of activities) {
    if (activity.status !== 'completed') continue
    for (const path of recordedToolFilePaths(activity)) add(path, cwd)
    const pending = [activity.rawOutput, ...(activity.toolContent ?? [])]
    let visited = 0
    while (pending.length && visited++ < 200) {
      let value = pending.pop()
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch {
          continue
        }
      }
      if (!value || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        pending.push(...value.slice(0, 200))
        continue
      }
      const record = value as Record<string, unknown>
      if (Array.isArray(record.workingFiles)) {
        for (const file of record.workingFiles) {
          if (!file || typeof file !== 'object') continue
          const entry = file as Record<string, unknown>
          add(
            entry.path ?? entry.relativePath,
            notebookRoot,
            safePath(entry.relativePath) ? entry.relativePath : undefined
          )
        }
      }
      pending.push(...Object.values(record).slice(0, 200))
    }
  }
  return [...files.values()]
}

const workingFilesForMessage = (
  session: ChatSession,
  message: ChatSession['messages'][number],
  notebookRoot?: string
): MessageArtifact[] => {
  const promptId = message.responseToMessageId
  if (message.role !== 'agent' || !promptId) return []
  const prompt = session.messages.find(({ id }) => id === promptId)
  if (!prompt) return []
  const nextPrompt = session.messages.find(
    (entry) => entry.role === 'user' && entry.createdAt > prompt.createdAt
  )
  const activities = (session.activities ?? []).filter((activity) =>
    activity.promptMessageId
      ? activity.promptMessageId === promptId
      : activity.createdAt >= prompt.createdAt &&
        activity.createdAt < (nextPrompt?.createdAt ?? Number.POSITIVE_INFINITY)
  )
  return recordedWorkingFiles(activities, session.cwd, notebookRoot).map((file) => ({
    ...file,
    resolvedProjectId: session.projectId,
    resolvedSessionId: session.id
  }))
}

// Keep immutable reference arrays stable while text streams. Only changed tool evidence is parsed.
const createMessageFileReferenceResolver = (): ((
  activeSession: ChatSession | undefined,
  artifactsForMessage: (message: ChatSession['messages'][number]) => MessageArtifact[],
  notebookRoot?: string
) => Map<string, MessageArtifact[]>) => {
  let previousReferences = new Map<string, MessageArtifact[]>()
  let previousSession: ChatSession | undefined
  let previousNotebookRoot: string | undefined
  let workingByPrompt = new Map<string, MessageArtifact[]>()
  return (activeSession, artifactsForMessage, notebookRoot) => {
    if (
      activeSession?.id !== previousSession?.id ||
      activeSession?.projectId !== previousSession?.projectId ||
      activeSession?.activities !== previousSession?.activities ||
      activeSession?.cwd !== previousSession?.cwd ||
      notebookRoot !== previousNotebookRoot
    ) {
      workingByPrompt = new Map()
    }
    previousSession = activeSession
    previousNotebookRoot = notebookRoot
    const references = new Map<string, MessageArtifact[]>()
    if (!activeSession) return references
    const artifactsByPrompt = new Map<string, Map<string, MessageArtifact>>()
    for (const message of activeSession.messages) {
      if (message.role !== 'agent') continue
      const promptId = message.responseToMessageId ?? message.id
      let turnArtifacts = artifactsByPrompt.get(promptId)
      if (!turnArtifacts) artifactsByPrompt.set(promptId, (turnArtifacts = new Map()))
      for (const artifact of artifactsForMessage(message))
        turnArtifacts.set(artifact.versionId ?? artifact.id, artifact)
    }
    for (const message of activeSession.messages) {
      if (message.role !== 'agent') continue
      const promptId = message.responseToMessageId ?? message.id
      let working = workingByPrompt.get(promptId)
      if (!working) {
        working = workingFilesForMessage(activeSession, message, notebookRoot)
        workingByPrompt.set(promptId, working)
      }
      const nextReferences = [...(artifactsByPrompt.get(promptId)?.values() ?? []), ...working]
      const previous = previousReferences.get(message.id)
      const unchanged =
        previous?.length === nextReferences.length &&
        nextReferences.every((reference, index) => {
          const old = previous[index]
          const keys = Object.keys(reference) as (keyof MessageArtifact)[]
          return (
            keys.length === Object.keys(old).length &&
            keys.every((key) => reference[key] === old[key])
          )
        })
      references.set(message.id, unchanged ? previous! : nextReferences)
    }
    previousReferences = references
    return references
  }
}

export { createMessageFileReferenceResolver, recordedWorkingFiles, workingFilesForMessage }
