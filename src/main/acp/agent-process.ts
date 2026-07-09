import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

// Resolves the packaged Claude ACP agent entry through Node's module resolver.
const resolveClaudeAgentAcpEntry = (): string =>
  nodeRequire.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')

// Converts Electron's asar virtual path to the real unpacked location for executable files.
const toUnpackedAsarPath = (filePath: string): string =>
  filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')

// Resolves the native Claude executable that the ACP agent spawns during session creation.
const resolveClaudeCodeExecutable = (): string =>
  toUnpackedAsarPath(nodeRequire.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'))

// Starts the bundled Claude ACP agent as a child process with pipe-based IO.
const spawnClaudeAgentAcp = (): ChildProcessWithoutNullStreams => {
  // Electron is the Node runtime available after packaging; this keeps dev and packaged paths aligned.
  return spawn(process.execPath, [resolveClaudeAgentAcpEntry()], {
    env: {
      ...process.env,
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? resolveClaudeCodeExecutable(),
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: 'pipe',
    windowsHide: true
  })
}

export {
  resolveClaudeAgentAcpEntry,
  resolveClaudeCodeExecutable,
  spawnClaudeAgentAcp,
  toUnpackedAsarPath
}
