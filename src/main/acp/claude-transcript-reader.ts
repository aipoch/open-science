import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

import type { ClaudeTranscriptReader } from './claude-turn-adapter'

const nodeRequire = createRequire(import.meta.url)
const { getSessionMessages } = nodeRequire(
  '@anthropic-ai/claude-agent-sdk'
) as typeof import('@anthropic-ai/claude-agent-sdk')

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const transcriptPath = (configDir: string, key: SessionKey): string => {
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

const parseTranscriptEntries = (text: string): SessionStoreEntry[] =>
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
      return value as SessionStoreEntry
    })

const createReadOnlyClaudeSessionStore = (configDir: string): SessionStore => ({
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

const createClaudeTranscriptReader = (configDir: string): ClaudeTranscriptReader => {
  const sessionStore = createReadOnlyClaudeSessionStore(configDir)
  return ({ providerSessionId, cwd }) =>
    getSessionMessages(providerSessionId, {
      dir: cwd,
      sessionStore
    })
}

export { createClaudeTranscriptReader }
