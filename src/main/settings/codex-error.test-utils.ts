import { RequestError, type SessionNotification } from '@agentclientprotocol/sdk'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureManagedCodexContextUsage } from './managed-codex'

export type CodexErrorNotification = {
  turnId: string
  willRetry: boolean
  error: { message: string; codexErrorInfo: unknown; additionalDetails: string | null }
}

type PinnedCodexErrorHandler = {
  sessionState: { authConfigured: boolean; currentTurnId: string | null }
  createErrorEvent(params: CodexErrorNotification): Promise<SessionNotification['update'] | null>
  getFailure(): RequestError | null
}

// Exercise installed-adapter normalization, then execute the verbatim upstream error translator.
// The fixture is offline and pinned; neither a real model nor a new production test seam is needed.
export const loadManagedCodexErrorHandler = async (
  directory: string
): Promise<PinnedCodexErrorHandler> => {
  const source = await readFile(
    new URL('./fixtures/codex-acp-1.6.2-error-handler.txt', import.meta.url),
    'utf8'
  )
  const adapterPath = join(directory, 'index.js')
  await writeFile(adapterPath, source)
  await ensureManagedCodexContextUsage(adapterPath)
  const normalized = await readFile(adapterPath, 'utf8')
  const handlerSource = normalized.split('// Other pinned patch targets')[0]
  return Function(
    'RequestError',
    'logger',
    `${handlerSource}\nreturn new PinnedCodexErrorHandler()`
  )(RequestError, { log: () => undefined }) as PinnedCodexErrorHandler
}
