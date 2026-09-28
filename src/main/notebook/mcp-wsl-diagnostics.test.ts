import { resolve } from 'node:path'

import { expect, it } from 'vitest'

import { loadWslSetupGuide } from '../wsl/wsl-setup-guide'
import { WslSetupOwner } from '../wsl/wsl-setup-owner'
import { buildNotebookToolContent, notebookRpcToolsForEnvironment } from './mcp-server'

it('delivers the bundled WSL guide and structured diagnostics through MCP without truncation', async () => {
  const owner = new WslSetupOwner({
    runner: { run: async () => ({ stdout: 'WSL version: 2.7.14.0', stderr: '', exitCode: 0 }) },
    workspacePath: 'C:\\workspace',
    volumeProbe: async () => ({ kind: 'local-ntfs' }),
    readSelection: async () => undefined,
    writeSelection: async () => undefined,
    loadGuide: () => loadWslSetupGuide([resolve('resources/guides/wsl2-setup.md')])
  })
  const handoff = await owner.createSupportHandoff()
  const tool = notebookRpcToolsForEnvironment({
    endpoint: 'http://127.0.0.1:4567',
    token: 'test-token',
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: '/workspace',
    wslSetupTools: true
  }).find(({ name }) => name === 'wsl_setup_diagnostics')!
  const content = buildNotebookToolContent(handoff, tool)
  const text = content.find((item) => item.type === 'text')!
  expect(text.type).toBe('text')
  if (text.type !== 'text') throw new Error('Missing diagnostic text')
  const delivered = JSON.parse(text.text)
  expect(handoff.guide.status).toBe('available')
  expect(delivered.schemaVersion).toBe(handoff.schemaVersion)
  expect(delivered.guide).toEqual(handoff.guide)
  expect(delivered.checks).toEqual(handoff.checks)
  expect(delivered).not.toHaveProperty('truncated')
  expect(delivered).not.toHaveProperty('setupSessionToken')
  expect(text.text.length).toBeLessThanOrEqual(tool.resultLimitChars!)
})
