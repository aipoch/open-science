import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AgentConfigFile } from '../agent-framework/types'

type AgentConfigFileWriteOptions = {
  renameFile?: typeof rename
  retryDelaysMs?: readonly number[]
}

const CONTENT_ADDRESSED_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EEXIST', 'ENOTEMPTY'])

const contentMatches = async (path: string, expected: string): Promise<boolean> =>
  readFile(path, 'utf8').then(
    (content) => content === expected,
    () => false
  )

const publishContentAddressedFile = async (
  file: AgentConfigFile,
  options: AgentConfigFileWriteOptions
): Promise<void> => {
  if (await contentMatches(file.path, file.content)) return

  // Keep the temporary file beside its destination so rename is an atomic same-filesystem publish.
  // Concurrent writers have identical content by contract: on platforms that reject replacing an
  // existing destination, a winner with matching bytes is equivalent to our own publication.
  const temporaryPath = `${file.path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, file.content, { encoding: 'utf8', mode: file.mode })
    if (file.mode !== undefined) await chmod(temporaryPath, file.mode)

    const renameFile = options.renameFile ?? rename
    const retryDelaysMs = options.retryDelaysMs ?? CONTENT_ADDRESSED_RENAME_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameFile(temporaryPath, file.path)
        break
      } catch (error) {
        if (await contentMatches(file.path, file.content)) break
        const code = (error as NodeJS.ErrnoException)?.code
        const retryDelay = retryDelaysMs[attempt]
        if (!TRANSIENT_RENAME_ERROR_CODES.has(code ?? '') || retryDelay === undefined) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelay))
        // A concurrent publisher may become visible only after the failing rename releases its
        // Windows file-system lock. Accept its byte-identical result without touching it again.
        if (await contentMatches(file.path, file.content)) break
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export const writeAgentConfigFiles = async (
  files: AgentConfigFile[] | undefined,
  options: AgentConfigFileWriteOptions = {}
): Promise<void> => {
  for (const file of files ?? []) {
    await mkdir(dirname(file.path), { recursive: true })
    if (file.contentAddressed) {
      await publishContentAddressedFile(file, options)
      continue
    }

    await writeFile(file.path, file.content, { encoding: 'utf8', mode: file.mode })
    if (file.mode !== undefined) await chmod(file.path, file.mode)
  }
}
