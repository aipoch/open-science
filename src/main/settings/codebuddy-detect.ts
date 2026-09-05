import path from 'node:path'

import {
  collectCandidateDirs,
  createDefaultDetectDeps,
  type OpencodeDetectDeps
} from './opencode-detect'
import { CODEBUDDY_VERSION } from './codebuddy-install'

export type CodeBuddyDetectDeps = OpencodeDetectDeps
export type CodeBuddyDetectResult = { resolvedPath: string; version?: string }

export const isSupportedCodeBuddyVersion = (
  version: string | undefined | null
): version is string => version === CODEBUDDY_VERSION

const binaryNames = (platform: NodeJS.Platform): string[] => {
  const commands = ['codebuddy', 'codebuddy-code', 'cbc']
  return platform === 'win32'
    ? commands.flatMap((command) => [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command])
    : commands
}

export const detectCodeBuddy = async (
  deps: CodeBuddyDetectDeps = createDefaultDetectDeps(),
  signal?: AbortSignal
): Promise<CodeBuddyDetectResult | undefined> => {
  signal?.throwIfAborted()
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix
  for (const dir of await collectCandidateDirs(deps, signal)) {
    for (const name of binaryNames(deps.platform)) {
      const candidate = pathApi.join(dir, name)
      const executable = await deps.isExecutable(candidate)
      signal?.throwIfAborted()
      if (!executable) continue
      const version = await deps.getVersion(candidate, signal)
      signal?.throwIfAborted()
      if (isSupportedCodeBuddyVersion(version)) return { resolvedPath: candidate, version }
    }
  }
  return undefined
}
