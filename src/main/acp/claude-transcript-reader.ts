import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { resolveClaudeAgentAcpEntry } from './agent-process'
import type { ClaudeTranscriptReader } from './claude-turn-adapter'

type ClaudeSessionKey = {
  projectKey: string
  sessionId: string
  subpath?: string
}

type ClaudeSessionStoreEntry = Record<string, unknown> & { type: string }

type ClaudeSessionStore = {
  append: (...entries: readonly unknown[]) => Promise<void>
  load: (key: ClaudeSessionKey) => Promise<readonly ClaudeSessionStoreEntry[] | null>
}

type GetSessionMessages = (
  sessionId: string,
  options: { dir: string; sessionStore: ClaudeSessionStore }
) => Promise<readonly unknown[]>

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const transcriptPath = (configDir: string, key: ClaudeSessionKey): string => {
  if (key.subpath) throw new Error('Claude subagent transcripts are not model-call sources.')
  const projectsRoot = resolve(configDir, 'projects')
  const path = resolve(projectsRoot, key.projectKey, `${key.sessionId}.jsonl`)
  const fromProjectsRoot = relative(projectsRoot, path)
  if (
    fromProjectsRoot === '..' ||
    fromProjectsRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromProjectsRoot)
  ) {
    throw new Error('Claude transcript path escapes its configured project store.')
  }
  return path
}

const parseTranscriptEntries = (text: string): ClaudeSessionStoreEntry[] =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as { type?: unknown }).type !== 'string'
      ) {
        throw new Error('Claude transcript contains a malformed entry.')
      }
      return value as ClaudeSessionStoreEntry
    })

const createReadOnlyClaudeSessionStore = (configDir: string): ClaudeSessionStore => ({
  append: async () => {
    throw new Error('Claude transcript recovery is read-only.')
  },
  load: async (key) => {
    try {
      return parseTranscriptEntries(await readFile(transcriptPath(configDir, key), 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }
})

const resolveGetSessionMessages = (): GetSessionMessages => {
  const sdk = createRequire(resolveClaudeAgentAcpEntry())('@anthropic-ai/claude-agent-sdk') as {
    getSessionMessages?: GetSessionMessages
  }
  if (!sdk.getSessionMessages) throw new Error('Claude Agent SDK transcript API is unavailable.')
  return sdk.getSessionMessages
}

const createClaudeTranscriptReader = (
  configDir: string,
  getSessionMessages?: GetSessionMessages
): ClaudeTranscriptReader => {
  const sessionStore = createReadOnlyClaudeSessionStore(configDir)
  let resolvedGetSessionMessages = getSessionMessages
  return ({ providerSessionId, cwd }) => {
    resolvedGetSessionMessages ??= resolveGetSessionMessages()
    return resolvedGetSessionMessages(providerSessionId, { dir: cwd, sessionStore })
  }
}

export type { GetSessionMessages, ClaudeSessionKey, ClaudeSessionStore }
export { createClaudeTranscriptReader }
