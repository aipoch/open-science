import { describe, expect, it } from 'vitest'

import { NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import { claudeCodeFramework } from './claude-code'
import { createCodeBuddyFramework } from './codebuddy'
import { createCodexFramework } from './codex'
import { opencodeFramework } from './opencode'
import { listAgentFrameworks } from './registry'

describe('native shell policy', () => {
  it('disables each framework-native shell surface', () => {
    const claudeOptions = (
      claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] }).meta?.claudeCode as {
        options: { disallowedTools: string[] }
      }
    ).options
    expect(claudeOptions.disallowedTools).toContain('Bash')

    const opencode = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['openai'],
        baseUrl: 'https://gateway.example/v1',
        model: 'test-model',
        key: 'test-key'
      },
      { storageRoot: '/data', executablePath: '/runtime/opencode' }
    )
    expect(JSON.parse(opencode.env?.OPENCODE_CONFIG_CONTENT ?? '{}').permission.bash).toBe('deny')

    const codex = createCodexFramework().prepareModelConfig(
      { type: 'codex-isolated', model: 'gpt-5.4' },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )
    expect(JSON.parse(codex.env?.CODEX_CONFIG ?? '{}').features.shell_tool).toBe(false)

    const codebuddy = createCodeBuddyFramework({ platform: 'linux' }).prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['openai'],
        baseUrl: 'https://gateway.example/v1',
        model: 'test-model',
        key: 'test-key'
      },
      { storageRoot: '/data', executablePath: '/runtime/codebuddy' }
    )
    const enabledTools = codebuddy.args?.[codebuddy.args.indexOf('--tools') + 1]
    expect(enabledTools?.split(',')).not.toContain('Bash')
  })

  it('keeps the app-owned Notebook shell available to every framework', () => {
    expect(listAgentFrameworks()).toHaveLength(4)
    expect(listAgentFrameworks().every((framework) => framework.acceptsStdioMcp)).toBe(true)
    expect(NOTEBOOK_RPC_TOOLS).toContainEqual(
      expect.objectContaining({ name: 'bash_execute', method: 'executeShell' })
    )
  })
})
