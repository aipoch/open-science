import { DesktopCapabilityUnavailable } from './desktop-interaction'
import { toApplicationCommandErrorEnvelope } from '../shared/application-command-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeRuntimeEnvironment, nodeRuntimeEnvironmentEntries } from './node-process-host'
import { isRuntimeHelper, runRuntimeHelper } from './runtime-helper'
import { HARNESS_ACP_ARG } from './harness-acp/config'
import {
  ARTIFACT_MCP_SERVER_ARG,
  IMAGE_MCP_SERVER_ARG,
  NOTEBOOK_MCP_SERVER_ARG,
  PLAN_MCP_SERVER_ARG,
  REVIEWER_MCP_PROXY_ARG,
  SKILL_IMPORT_MCP_SERVER_ARG,
  SKILL_RUNTIME_MCP_SERVER_ARG
} from './mcp-server-args'
import { installationHelperFlags } from '../../packages/open-science/installation-startup.cjs'

vi.mock('./harness-acp/entry', () => ({ runHarnessAcp: vi.fn() }))
vi.mock('./artifacts/mcp-server', () => ({ runArtifactMcpServer: vi.fn() }))
vi.mock('./image-model/mcp-server', () => ({ runImageMcpServer: vi.fn() }))
vi.mock('./notebook/mcp-server', () => ({ runNotebookMcpServer: vi.fn() }))
vi.mock('./reviewer/mcp-stdio-proxy', () => ({ runReviewerMcpStdioProxy: vi.fn() }))
vi.mock('./skills/mcp-server', () => ({ runSkillImportMcpServer: vi.fn() }))
vi.mock('./skills/runtime-mcp-server', () => ({ runSkillRuntimeMcpServer: vi.fn() }))
vi.mock('./session-plan/plan-mcp-server', () => ({ runPlanMcpServer: vi.fn() }))

const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron')
afterEach(() => {
  if (electronVersion) Object.defineProperty(process.versions, 'electron', electronVersion)
  else Reflect.deleteProperty(process.versions, 'electron')
  vi.unstubAllEnvs()
})

describe('helper host inheritance', () => {
  it.each([undefined, '43.7.5'])('uses the correct Node mode for host %s', (electron) => {
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: electron })
    vi.stubEnv('ELECTRON_RUN_AS_NODE', 'stale-parent-value')
    vi.stubEnv('OPEN_SCIENCE_HOST_HOME', '/fixture/home')
    vi.stubEnv('OPEN_SCIENCE_APPLICATION_PATH', '/fixture/app')
    vi.stubEnv('OPEN_SCIENCE_RESOURCES_PATH', '/fixture/resources')
    vi.stubEnv('OPEN_SCIENCE_APPLICATION_VERSION', '0.35.1')
    vi.stubEnv('OPEN_SCIENCE_HOST_PACKAGED', '0')
    vi.stubEnv('OPEN_SCIENCE_INSTALLATION_OWNER', 'fixture-owner-capability')
    vi.stubEnv('OPEN_SCIENCE_INSTALLATION_STATE_ROOT', '/fixture/installation-state')
    const values = nodeRuntimeEnvironment()
    expect(values).toEqual({
      ELECTRON_RUN_AS_NODE: electron ? '1' : undefined,
      OPEN_SCIENCE_HOST_HOME: '/fixture/home',
      OPEN_SCIENCE_APPLICATION_PATH: '/fixture/app',
      OPEN_SCIENCE_RESOURCES_PATH: '/fixture/resources',
      OPEN_SCIENCE_APPLICATION_VERSION: '0.35.1',
      OPEN_SCIENCE_HOST_PACKAGED: '0',
      OPEN_SCIENCE_INSTALLATION_OWNER: 'fixture-owner-capability',
      OPEN_SCIENCE_INSTALLATION_STATE_ROOT: '/fixture/installation-state'
    })
    expect(nodeRuntimeEnvironmentEntries()).toContainEqual({
      name: 'OPEN_SCIENCE_HOST_PACKAGED',
      value: '0'
    })
    expect(nodeRuntimeEnvironmentEntries()).toEqual(
      expect.arrayContaining([
        { name: 'OPEN_SCIENCE_INSTALLATION_OWNER', value: 'fixture-owner-capability' },
        { name: 'OPEN_SCIENCE_INSTALLATION_STATE_ROOT', value: '/fixture/installation-state' }
      ])
    )
    expect(
      nodeRuntimeEnvironmentEntries().some(({ name }) => name === 'ELECTRON_RUN_AS_NODE')
    ).toBe(Boolean(electron))
  })
  it('reports unavailable desktop capabilities through the existing public error protocol', () => {
    expect(
      toApplicationCommandErrorEnvelope(new DesktopCapabilityUnavailable('Choose files'))
    ).toEqual({
      code: 'command-unavailable',
      message:
        'Choose files requires the Open-Science desktop app. It is unavailable in the Node backend.'
    })
  })
  it('does not classify normal startup or partial helper flags as helper processes', () => {
    expect(isRuntimeHelper(['node', 'entry', '--serve=44100'])).toBe(false)
    expect(isRuntimeHelper(['--open-science-notebook-mcp-extra'])).toBe(false)
    expect(isRuntimeHelper(['--open-science-notebook-mcp'])).toBe(true)
  })
  it('keeps startup protection and runtime helper flags aligned', () => {
    expect(installationHelperFlags).toEqual([
      HARNESS_ACP_ARG,
      ARTIFACT_MCP_SERVER_ARG,
      IMAGE_MCP_SERVER_ARG,
      NOTEBOOK_MCP_SERVER_ARG,
      REVIEWER_MCP_PROXY_ARG,
      SKILL_IMPORT_MCP_SERVER_ARG,
      SKILL_RUNTIME_MCP_SERVER_ARG,
      PLAN_MCP_SERVER_ARG
    ])
    for (const flag of installationHelperFlags)
      expect(isRuntimeHelper(['node', 'entry', flag])).toBe(true)
  })
  it('dispatches every registered runtime helper mode', async () => {
    for (const flag of installationHelperFlags)
      expect(await runRuntimeHelper(['node', 'entry', flag])).toBe(true)
    expect(await runRuntimeHelper(['node', 'entry'])).toBe(false)
  })
})
