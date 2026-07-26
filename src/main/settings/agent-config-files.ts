import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AgentConfigFile } from '../agent-framework/types'

const contentMatches = async (path: string, expected: string): Promise<boolean> =>
  readFile(path, 'utf8').then(
    (content) => content === expected,
    () => false
  )

const publishContentAddressedFile = async (file: AgentConfigFile): Promise<void> => {
  if (await contentMatches(file.path, file.content)) return

  // Keep the temporary file beside its destination so rename is an atomic same-filesystem publish.
  // Concurrent writers have identical content by contract: on platforms that reject replacing an
  // existing destination, a winner with matching bytes is equivalent to our own publication.
  const temporaryPath = `${file.path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, file.content, { encoding: 'utf8', mode: file.mode })
    if (file.mode !== undefined) await chmod(temporaryPath, file.mode)

    try {
      await rename(temporaryPath, file.path)
    } catch (error) {
      if (!(await contentMatches(file.path, file.content))) throw error
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export const writeAgentConfigFiles = async (
  files: AgentConfigFile[] | undefined
): Promise<void> => {
  for (const file of files ?? []) {
    await mkdir(dirname(file.path), { recursive: true })
    if (file.contentAddressed) {
      await publishContentAddressedFile(file)
      continue
    }

    await writeFile(file.path, file.content, { encoding: 'utf8', mode: file.mode })
    if (file.mode !== undefined) await chmod(file.path, file.mode)
  }
}
