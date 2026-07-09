import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../../..')

const runtimeEventConsumerPaths = [
  'src/shared/acp.ts',
  'src/main/acp/ipc.ts',
  'src/main/acp/runtime.ts',
  'src/preload/index.ts',
  'src/preload/index.d.ts',
  'src/renderer/src/lib/acp/chat-events.ts',
  'src/renderer/src/lib/acp/workspace-events.ts',
  'src/renderer/src/lib/acp/workspace-events.test.ts'
]

const debugEntryPointPaths = [
  'src/main/ipc.ts',
  'src/main/windows.ts',
  'src/preload/index.ts',
  'src/preload/index.d.ts'
]

describe('ACP runtime event naming', () => {
  it('uses neutral runtime event names for the conversation event stream', () => {
    for (const filePath of runtimeEventConsumerPaths) {
      const source = readFileSync(resolve(projectRoot, filePath), 'utf8')

      expect(source).not.toMatch(/AcpDebugEvent|DebugEvent|debug-events|toAcpDebugEvent/)
    }

    expect(existsSync(resolve(projectRoot, 'src/main/acp/debug-events.ts'))).toBe(false)
    expect(existsSync(resolve(projectRoot, 'src/main/acp/debug-events.test.ts'))).toBe(false)
  })

  it('does not expose removed ACP debug entry points from main or preload', () => {
    for (const filePath of debugEntryPointPaths) {
      const source = readFileSync(resolve(projectRoot, filePath), 'utf8')

      expect(source).not.toMatch(/acp-debug:open-window|openAcpDebugWindow|acpDebugWindow/)
      expect(source).not.toMatch(/AcpDebugWindow|RendererWindow|window=acp-debug/)
    }
  })
})
