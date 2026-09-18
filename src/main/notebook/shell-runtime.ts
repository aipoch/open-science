import { z } from 'zod'

import type { ShellRuntimeBinding } from '../../shared/notebook'
import type { NotebookSandboxTarget } from './process-sandbox'

export type ShellRuntimeDialect = 'powershell' | 'posix'
export type ShellRuntimeAgentContract = Readonly<{
  commandDescription: string
  executionDescription: string
  sessionInstruction: string
}>

export const shellRuntimeBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('powershell'), version: z.literal('5.1') }).strict(),
  z.object({ kind: z.literal('native-posix'), shell: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('wsl2-bash'),
      profileId: z.string().min(1),
      distro: z.string().min(1),
      user: z.string().min(1)
    })
    .strict()
])

export const captureShellRuntimeBinding = (binding: ShellRuntimeBinding): ShellRuntimeBinding => {
  switch (binding.kind) {
    case 'powershell':
      return Object.freeze({ kind: 'powershell', version: binding.version })
    case 'native-posix':
      return Object.freeze({ kind: 'native-posix', shell: binding.shell })
    case 'wsl2-bash':
      return Object.freeze({
        kind: 'wsl2-bash',
        profileId: binding.profileId,
        distro: binding.distro,
        user: binding.user
      })
  }
}

export const defaultShellRuntimeBinding = (
  platform: NodeJS.Platform = process.platform
): ShellRuntimeBinding =>
  platform === 'win32'
    ? Object.freeze({ kind: 'powershell', version: '5.1' })
    : Object.freeze({ kind: 'native-posix', shell: '/bin/sh' })

export const shellRuntimeDialect = (binding: ShellRuntimeBinding): ShellRuntimeDialect =>
  binding.kind === 'powershell' ? 'powershell' : 'posix'

// Keep every Agent-facing dialect cue derived from the same immutable binding without exposing
// profile identity. MCP schemas and Session presentation consume this small shared interface.
export const shellRuntimeAgentContract = (
  binding: ShellRuntimeBinding
): ShellRuntimeAgentContract => {
  switch (binding.kind) {
    case 'powershell':
      return Object.freeze({
        commandDescription: 'Windows PowerShell 5.1 command; do not use POSIX shell syntax.',
        executionDescription: 'Run PowerShell in the shared session workspace.',
        sessionInstruction:
          'Notebook `bash_execute` is bound to Windows PowerShell 5.1 for this Session. Generate PowerShell commands, not POSIX shell syntax.'
      })
    case 'wsl2-bash':
      return Object.freeze({
        commandDescription: 'WSL2 Bash command using POSIX syntax; do not use PowerShell syntax.',
        executionDescription:
          'Run one WSL2 Bash command in the shared session workspace. Use Bash syntax; execution stays in the selected sandboxed WSL2 profile.',
        sessionInstruction:
          'Notebook `bash_execute` is bound to WSL2 Bash for this Session. Generate POSIX Bash commands even though the host and workspace path are Windows; never emit PowerShell syntax.'
      })
    case 'native-posix': {
      return Object.freeze({
        commandDescription: 'Command for the native POSIX shell; do not use PowerShell syntax.',
        executionDescription:
          'Run one command with the native POSIX shell in the shared session workspace.',
        sessionInstruction:
          'Notebook `bash_execute` is bound to the native POSIX shell for this Session. Generate POSIX shell commands, not PowerShell syntax.'
      })
    }
  }
}

export const shellRuntimeSandboxTarget = (binding: ShellRuntimeBinding): NotebookSandboxTarget =>
  binding.kind === 'wsl2-bash'
    ? Object.freeze({
        kind: 'wsl2',
        profileId: binding.profileId,
        distro: binding.distro,
        user: binding.user
      })
    : Object.freeze({ kind: 'native' })

export const shellRuntimePlatform = (
  binding: ShellRuntimeBinding,
  hostPlatform: NodeJS.Platform = process.platform
): NodeJS.Platform => {
  switch (binding.kind) {
    case 'powershell':
      return 'win32'
    case 'native-posix':
      return hostPlatform
    case 'wsl2-bash':
      return 'linux'
  }
}
