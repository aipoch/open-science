import { describe, expect, it } from 'vitest'

import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import {
  ELECTRON_APPLICATION_COMMAND_CHANNELS,
  RENDERER_CONTRACT_CATALOG
} from './renderer-contract-catalog'
import { projectRendererContractMaps } from './renderer-contract'

const paths = (
  predicate: (contract: (typeof RENDERER_CONTRACT_CATALOG)[number]) => boolean
): string[] => RENDERER_CONTRACT_CATALOG.filter(predicate).map(({ publicPath }) => publicPath)

describe('renderer contract catalog', () => {
  it('pins the complete capability-owned inventory and legacy map projection', () => {
    const projection = projectRendererContractMaps(RENDERER_CONTRACT_CATALOG)

    expect(projection.invoke).toEqual(WEB_INVOKE_CHANNELS)
    expect(projection.event).toEqual(WEB_EVENT_CHANNELS)
  })

  it('separates actual Web installation from the generated compatibility projection', () => {
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
    ).toEqual(['acp.connect', 'acp.createSession', 'notebookEnv.cancel', 'sessions.saveSession'])

    const explicitEquivalentTransforms = paths(
      ({ parameterCodec }) =>
        parameterCodec.electron === parameterCodec.web &&
        parameterCodec.web !== 'positional' &&
        parameterCodec.web !== 'event-listener' &&
        parameterCodec.web !== 'surface-native'
    )
    expect(explicitEquivalentTransforms).toEqual([
      'runtime.describeUsage',
      'runtime.getEnablement',
      'runtime.listPackageCounts',
      'runtime.listPackages',
      'runtime.registerInterpreter',
      'runtime.setEnvironmentEnabled',
      'runtime.setInstallAuthorized',
      'runtime.setSelection',
      'runtime.unregisterInterpreter',
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
    expect(specialist).toHaveLength(31)
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
    expect(compute).toHaveLength(33)
    expect(
      compute
        .filter(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
        .map(({ publicPath }) => publicPath)
    ).toEqual([
      'compute.changeAuthentication',
      'compute.createPassword',
      'compute.download',
      'compute.passwordCapability',
      'compute.resetPassword',
      'compute.revealInFolder'
    ])
  })

  it('publishes Session projection reads on every renderer surface', () => {
    const projectionReads = RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
      ['sessions.list', 'sessions.loadOne', 'sessions.loadUsage'].includes(publicPath)
    )

    expect(projectionReads).toHaveLength(3)
    expect(
      projectionReads.every(
        ({ surfaceInstallation }) =>
          surfaceInstallation.electron === 'preload' &&
          surfaceInstallation.localWeb === 'web-rpc' &&
          surfaceInstallation.remoteWeb === 'web-rpc'
      )
    ).toBe(true)
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

  it('marks the runtime-validated command slice', () => {
    expect(paths(({ applicationCommand }) => applicationCommand === 'runtime-validated')).toEqual([
      'projects.create',
      'projects.delete',
      'projects.get',
      'projects.list',
      'projects.update',
      'projects.updateArchive',
      'sessions.deleteSession',
      'tags.create',
      'tags.delete',
      'tags.reorder',
      'tags.setAssignment',
      'tags.snapshot',
      'tags.update'
    ])
    expect(ELECTRON_APPLICATION_COMMAND_CHANNELS).toEqual([
      'projects:create',
      'projects:delete',
      'projects:get',
      'projects:list',
      'projects:update',
      'projects:update-archive',
      'sessions:delete-session',
      'tags:create',
      'tags:delete',
      'tags:reorder',
      'tags:set-assignment',
      'tags:snapshot',
      'tags:update'
    ])
  })
})
