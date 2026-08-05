import { describe, expect, it } from 'vitest'

import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import { RENDERER_CONTRACT_CATALOG, RENDERER_CONTRACT_GROUPS } from './renderer-contract-catalog'
import { projectRendererContractMaps } from './renderer-contract'

const paths = (
  predicate: (contract: (typeof RENDERER_CONTRACT_CATALOG)[number]) => boolean
): string[] => RENDERER_CONTRACT_CATALOG.filter(predicate).map(({ publicPath }) => publicPath)

describe('renderer contract catalog', () => {
  it('pins the complete capability-owned inventory and legacy map projection', () => {
    const projection = projectRendererContractMaps(RENDERER_CONTRACT_CATALOG)

    expect(RENDERER_CONTRACT_GROUPS).toHaveLength(30)
    expect(RENDERER_CONTRACT_CATALOG).toHaveLength(302)
    expect(projection.invoke).toEqual(WEB_INVOKE_CHANNELS)
    expect(projection.event).toEqual(WEB_EVENT_CHANNELS)
    expect(Object.keys(projection.invoke)).toHaveLength(225)
    expect(Object.keys(projection.event)).toHaveLength(32)
  })

  it('separates actual Web installation from the generated compatibility projection', () => {
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb !== 'unavailable')
    ).toHaveLength(253)
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb === 'browser-native')
    ).toEqual(['getRuntimeVersions', 'saveBlobFile', 'saveManagedFile', 'window.close'])
    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        ['saveBlobFile', 'window.close'].includes(publicPath)
      ).every(
        ({ dispatchPolicy, authorityFlow }) =>
          dispatchPolicy.electron === 'electron-ipc-request' &&
          dispatchPolicy.localWeb === 'surface-native' &&
          authorityFlow.electron === 'electron-sender'
      )
    ).toBe(true)
    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'saveManagedFile')
    ).toMatchObject({
      dispatchPolicy: {
        electron: 'electron-ipc-request',
        localWeb: 'browser-native-with-direct-application-request',
        remoteWeb: 'browser-native-with-direct-application-request'
      },
      authorityFlow: {
        electron: 'electron-sender',
        localWeb: 'caller-context',
        remoteWeb: 'caller-context'
      }
    })
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb === 'unavailable')
    ).toHaveLength(49)
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
    ).toHaveLength(56)
    expect(
      paths(({ eventDeliverability }) =>
        Object.values(eventDeliverability).includes('installed-undelivered')
      )
    ).toEqual([
      'notebookEnv.onProgress',
      'notifications.onOpenSession',
      'notifications.onViewProbe',
      'uploads.onTransferProgress',
      'window.onCloseActivePane'
    ])
  })

  it('records every intentional and known-deviating argument codec without normalizing it', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'uploads.stageLocalFile')
        ?.parameterCodec
    ).toEqual({ electron: 'native-file-upload-request', web: 'native-file-upload-request' })

    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        ['acp.connect', 'acp.createSession'].includes(publicPath)
      ).map(({ publicPath, parameterCodec }) => ({ publicPath, parameterCodec }))
    ).toEqual([
      {
        publicPath: 'acp.connect',
        parameterCodec: {
          electron: 'default-empty-object',
          web: 'default-empty-object-absent-only'
        }
      },
      {
        publicPath: 'acp.createSession',
        parameterCodec: {
          electron: 'default-empty-object',
          web: 'default-empty-object-absent-only'
        }
      }
    ])

    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'notebookEnv.cancel')
        ?.parameterCodec
    ).toEqual({ electron: 'optional-argument-slot', web: 'positional' })

    expect(
      paths(
        ({ parameterCodec, surfaceInstallation }) =>
          surfaceInstallation.localWeb === 'web-rpc' &&
          parameterCodec.electron !== parameterCodec.web
      )
    ).toEqual([
      'acp.connect',
      'acp.createSession',
      'notebookEnv.cancel',
      'runtime.describeUsage',
      'runtime.getEnablement',
      'runtime.listPackageCounts',
      'runtime.listPackages',
      'runtime.registerInterpreter',
      'runtime.setEnvironmentEnabled',
      'runtime.setInstallAuthorized',
      'runtime.setSelection',
      'runtime.unregisterInterpreter',
      'sessions.saveSession'
    ])

    const explicitEquivalentTransforms = paths(
      ({ parameterCodec }) =>
        parameterCodec.electron === parameterCodec.web &&
        parameterCodec.web !== 'positional' &&
        parameterCodec.web !== 'event-listener' &&
        parameterCodec.web !== 'surface-native'
    )
    expect(explicitEquivalentTransforms).toEqual([
      'storage.commitAndRelaunch',
      'storage.discardMigratedCopy',
      'storage.inspectDataRoot',
      'storage.migrate',
      'storage.setDataRootAndRelaunch',
      'storage.validateDataRoot',
      'uploads.stageLocalFile'
    ])
  })

  it('preserves Specialist, Permission, and Compute surface asymmetry', () => {
    const specialist = RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
      publicPath.startsWith('specialist.')
    )
    expect(specialist).toHaveLength(22)
    expect(
      specialist.every(
        ({ surfaceInstallation }) =>
          surfaceInstallation.localWeb === 'unavailable' &&
          surfaceInstallation.remoteWeb === 'unavailable'
      )
    ).toBe(true)

    const permissionPaths = [
      'acp.respondToPermission',
      'acp.revokePermissionGrant',
      'acp.setPermissionProfile',
      'permissions.extendUndo',
      'permissions.list',
      'permissions.restore',
      'permissions.revoke'
    ]
    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        permissionPaths.includes(publicPath)
      ).every(
        ({ surfaceInstallation, authorityFlow }) =>
          surfaceInstallation.remoteWeb === 'web-rpc' &&
          authorityFlow.remoteWeb === 'caller-context'
      )
    ).toBe(true)

    const compute = RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
      publicPath.startsWith('compute.')
    )
    expect(compute).toHaveLength(23)
    expect(
      compute
        .filter(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
        .map(({ publicPath }) => publicPath)
    ).toEqual(['compute.download', 'compute.revealInFolder'])
  })

  it('records the paired window lifecycle channels and teardown ordering', () => {
    const lifecycleFor = (publicPath: string): unknown =>
      RENDERER_CONTRACT_CATALOG.find((contract) => contract.publicPath === publicPath)
        ?.lifecycleDispatch

    expect(lifecycleFor('window.onCloseActivePane')).toEqual({
      activateChannel: 'shortcut:close-active-pane-ready',
      activate: 'after-subscribe',
      deactivateChannel: 'shortcut:close-active-pane-unready',
      deactivate: 'after-unsubscribe'
    })
    expect(lifecycleFor('window.announceWindowFindReady')).toEqual({
      activateChannel: 'shortcut:window-find-ready',
      activate: 'on-call',
      deactivateChannel: 'shortcut:window-find-unready',
      deactivate: 'on-dispose'
    })
  })
})
