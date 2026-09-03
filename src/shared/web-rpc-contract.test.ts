import { describe, expect, it } from 'vitest'

import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import {
  isWebRpcChannel,
  isWebRpcEventChannel,
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  WEB_RPC_ALLOWED_CHANNELS,
  WEB_RPC_CAPABILITY_UPDATE_CLI_V1,
  WEB_RPC_PROTOCOL_VERSION,
  WEB_RPC_UNAVAILABLE_CHANNELS,
  webRpcBootstrapSchema,
  webRpcRequestSchema,
  webRpcResponseSchema
} from './web-rpc-contract'

describe('Web RPC contract', () => {
  it('classifies every preload invoke channel into the positive allowlist or explicit exclusions', () => {
    const preloadChannels = [...new Set(Object.values(WEB_INVOKE_CHANNELS))].sort()
    const classifiedChannels = [
      ...new Set([...WEB_RPC_ALLOWED_CHANNELS, ...WEB_RPC_UNAVAILABLE_CHANNELS])
    ].sort()

    expect(classifiedChannels).toEqual(preloadChannels)
    expect(WEB_RPC_ALLOWED_CHANNELS).toContain('projects:list')
    expect(WEB_RPC_ALLOWED_CHANNELS).not.toContain('window:close')
    expect(WEB_RPC_UNAVAILABLE_CHANNELS.every((channel) => !isWebRpcChannel(channel))).toBe(true)
  })

  it('uses the generated event interface as its positive event allowlist', () => {
    const preloadEvents = [...new Set(Object.values(WEB_EVENT_CHANNELS))].sort()
    expect(preloadEvents.every(isWebRpcEventChannel)).toBe(true)
    expect(isWebRpcEventChannel('test:internal')).toBe(false)
  })

  it('pins the local Web Specialist, Permission, and Compute surface asymmetry', () => {
    const invokePaths = Object.keys(WEB_INVOKE_CHANNELS)
    const eventPaths = Object.keys(WEB_EVENT_CHANNELS)

    expect(invokePaths.filter((path) => path.startsWith('specialist.'))).toEqual([])
    expect(eventPaths.filter((path) => path.startsWith('specialist.'))).toEqual([])

    expect(invokePaths.filter((path) => path.startsWith('permissions.'))).toEqual([
      'permissions.extendUndo',
      'permissions.list',
      'permissions.restore',
      'permissions.restoreDefaults',
      'permissions.revoke'
    ])
    expect(
      [
        WEB_INVOKE_CHANNELS['acp.respondToPermission'],
        WEB_INVOKE_CHANNELS['acp.revokePermissionGrant'],
        WEB_INVOKE_CHANNELS['acp.setPermissionProfile'],
        ...invokePaths
          .filter((path) => path.startsWith('permissions.'))
          .map((path) => WEB_INVOKE_CHANNELS[path as keyof typeof WEB_INVOKE_CHANNELS])
      ].every(isWebRpcChannel)
    ).toBe(true)
    expect(WEB_EVENT_CHANNELS['acp.onPermissionRequest']).toBe('acp:permission-request')
    expect(WEB_EVENT_CHANNELS['permissions.onChanged']).toBe('permissions:changed')

    expect(invokePaths.filter((path) => path.startsWith('compute.'))).toEqual([
      'compute.bookmarksGet',
      'compute.bookmarksSet',
      'compute.changeAuthentication',
      'compute.concurrencySet',
      'compute.create',
      'compute.createPassword',
      'compute.delete',
      'compute.deletionStatus',
      'compute.detailsGet',
      'compute.detailsSave',
      'compute.download',
      'compute.enabledHostsGet',
      'compute.enabledHostsSet',
      'compute.get',
      'compute.hostEnabledSet',
      'compute.hostSelectedSet',
      'compute.jobsCancel',
      'compute.jobsList',
      'compute.jobsMarkConsumed',
      'compute.jobsPendingNotification',
      'compute.jobsSetRemoteCleanup',
      'compute.jobsTransitionAnalysis',
      'compute.list',
      'compute.listDir',
      'compute.passwordCapability',
      'compute.probe',
      'compute.replayApproval',
      'compute.replayPendingApprovals',
      'compute.resetPassword',
      'compute.respondApproval',
      'compute.revealInFolder',
      'compute.scratchClear',
      'compute.scratchSet',
      'compute.sshConfigAliases'
    ])
    expect(
      invokePaths
        .filter((path) => path.startsWith('compute.'))
        .map((path) => WEB_INVOKE_CHANNELS[path as keyof typeof WEB_INVOKE_CHANNELS])
        .every(isWebRpcChannel)
    ).toBe(true)
    expect(eventPaths.filter((path) => path.startsWith('compute.'))).toEqual([
      'compute.onApprovalRequest',
      'compute.onApprovalSettled',
      'compute.onJobUpdated'
    ])
  })

  it('pins the local Web Notebook, environment, and runtime surfaces', () => {
    const invokePaths = Object.keys(WEB_INVOKE_CHANNELS)
    const eventPaths = Object.keys(WEB_EVENT_CHANNELS)

    expect(invokePaths.filter((path) => path.startsWith('notebook.'))).toEqual([
      'notebook.appendCodeCell',
      'notebook.beginCodeCell',
      'notebook.execute',
      'notebook.exportIpynb',
      'notebook.exportIpynbAll',
      'notebook.finishCodeCell',
      'notebook.getReference',
      'notebook.inspectNamespace',
      'notebook.readInputPreview',
      'notebook.restart',
      'notebook.runCell',
      'notebook.shutdown',
      'notebook.state'
    ])
    expect(invokePaths.filter((path) => path.startsWith('notebookEnv.'))).toEqual([
      'notebookEnv.cancel',
      'notebookEnv.getStatus',
      'notebookEnv.provision',
      'notebookEnv.repair'
    ])
    expect(invokePaths.filter((path) => path.startsWith('runtime.'))).toEqual([
      'runtime.describeUsage',
      'runtime.getAgentEnvironmentCreationEnabled',
      'runtime.getEnablement',
      'runtime.listEnvironments',
      'runtime.listPackageCounts',
      'runtime.listPackages',
      'runtime.pickInterpreter',
      'runtime.registerInterpreter',
      'runtime.setAgentEnvironmentCreationEnabled',
      'runtime.setEnvironmentEnabled',
      'runtime.setInstallAuthorized',
      'runtime.unregisterInterpreter'
    ])
    expect(eventPaths.filter((path) => path.startsWith('notebook.'))).toEqual([
      'notebook.onAvailable',
      'notebook.onChanged'
    ])
    // This generated mapping remains dormant for Web: production publishes environment progress
    // directly to Electron BrowserWindows and never adds it to ApplicationEventMap.
    expect(eventPaths.filter((path) => path.startsWith('notebookEnv.'))).toEqual([
      'notebookEnv.onProgress'
    ])
  })

  it('validates versioned request and response envelopes at runtime', () => {
    expect(
      webRpcRequestSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args: [{ projectId: 'project-1' }, Uint8Array.from([1, 2, 3])]
      }).success
    ).toBe(true)
    expect(webRpcRequestSchema.safeParse({ protocolVersion: 2, args: [] }).success).toBe(false)
    expect(
      webRpcRequestSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args: 'not-an-array'
      }).success
    ).toBe(false)
    expect(
      webRpcResponseSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid request.' }
      }).success
    ).toBe(true)
    expect(
      webRpcResponseSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        ok: false,
        error: {
          code: 'invalid-command-arguments',
          message: 'Invalid project request.'
        }
      }).success
    ).toBe(true)
  })

  it('accepts the versioned CLI update capability in bootstrap data', () => {
    expect(
      webRpcBootstrapSchema.safeParse({
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' },
        rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
        rpcCapabilities: [WEB_RPC_CAPABILITY_UPDATE_CLI_V1],
        rpcChannels: [],
        eventStream: {
          protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
          streamId: 'stream-1',
          latestSequence: 0
        }
      }).success
    ).toBe(true)
  })
})
