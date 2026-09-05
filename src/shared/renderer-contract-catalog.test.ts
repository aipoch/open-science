import { describe, expect, it } from 'vitest'

import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import {
  ELECTRON_APPLICATION_COMMAND_CHANNELS,
  RENDERER_CONTRACT_CATALOG,
  RENDERER_CONTRACT_GROUPS
} from './renderer-contract-catalog'
import { projectRendererContractMaps } from './renderer-contract'

const paths = (
  predicate: (contract: (typeof RENDERER_CONTRACT_CATALOG)[number]) => boolean
): string[] => RENDERER_CONTRACT_CATALOG.filter(predicate).map(({ publicPath }) => publicPath)

describe('renderer contract catalog', () => {
  it('does not expose the retired Runtime Selection API', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        ['runtime.setSelection', 'runtime.survey'].includes(publicPath)
      )
    ).toEqual([])
    expect(Object.values(WEB_INVOKE_CHANNELS)).not.toContain('runtime:set-selection')
    expect(Object.values(WEB_INVOKE_CHANNELS)).not.toContain('runtime:survey')
  })

  it('does not expose the obsolete disk-scanned Project Files command', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(
        ({ publicPath }) => publicPath === 'artifacts.listProjectFiles'
      )
    ).toBeUndefined()
    expect(Object.values(WEB_INVOKE_CHANNELS)).not.toContain('artifacts:list-project-files')
  })

  it('keeps the Remote Access probe local-only', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'remoteAccess.probe')
    ).toMatchObject({
      surfaceInstallation: {
        electron: 'preload',
        localWeb: 'web-rpc',
        remoteWeb: 'rejecting-stub'
      }
    })
  })

  it('keeps every logs command local-only', () => {
    const logs = RENDERER_CONTRACT_GROUPS.find(({ capability }) => capability === 'logs')

    expect(logs?.contracts.length).toBeGreaterThan(0)
    expect(
      logs?.contracts.every(
        ({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub'
      )
    ).toBe(true)
  })

  it('keeps custom Connector lifecycle mutations local-only', () => {
    const publicPaths = [
      'settings.addCustomServer',
      'settings.setCustomServerEnabled',
      'settings.removeCustomServer',
      'settings.updateCustomServer'
    ]

    expect(
      publicPaths.map((publicPath) =>
        RENDERER_CONTRACT_CATALOG.find((contract) => contract.publicPath === publicPath)
      )
    ).toEqual(
      publicPaths.map((publicPath) =>
        expect.objectContaining({
          publicPath,
          surfaceInstallation: {
            electron: 'preload',
            localWeb: 'web-rpc',
            remoteWeb: 'rejecting-stub'
          }
        })
      )
    )
  })

  it('publishes remote-access route management only on Electron', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        ['remoteAccess.detect', 'remoteAccess.disable', 'remoteAccess.setMode'].includes(publicPath)
      ).map(({ publicPath, surfaceInstallation, dispatchPolicy }) => ({
        publicPath,
        surfaceInstallation,
        dispatchPolicy
      }))
    ).toEqual(
      ['remoteAccess.detect', 'remoteAccess.disable', 'remoteAccess.setMode'].map((publicPath) => ({
        publicPath,
        surfaceInstallation: {
          electron: 'preload',
          localWeb: 'unavailable',
          remoteWeb: 'unavailable'
        },
        dispatchPolicy: {
          electron: 'electron-ipc-request',
          localWeb: 'none',
          remoteWeb: 'none'
        }
      }))
    )
  })

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
      paths(
        ({ surfaceInstallation, eventDeliverability }) =>
          surfaceInstallation.localWeb === 'web-event' &&
          eventDeliverability.localWeb !== 'application-event'
      )
    ).toEqual([])
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
    expect(compute).toHaveLength(37)
    expect(
      compute
        .filter(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
        .map(({ publicPath }) => publicPath)
    ).toEqual([
      'compute.changeAuthentication',
      'compute.createPassword',
      'compute.download',
      'compute.jobsSetRemoteCleanup',
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

  it('keeps opening Session recovery folders on the Electron surface', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(
        ({ publicPath }) => publicPath === 'sessions.openRecoveryFolder'
      )
    ).toMatchObject({
      surfaceInstallation: {
        electron: 'preload',
        localWeb: 'unavailable',
        remoteWeb: 'unavailable'
      },
      dispatchPolicy: {
        electron: 'electron-ipc-request',
        localWeb: 'none',
        remoteWeb: 'none'
      }
    })
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

  it('keeps preview frame context-menu requests on the Electron surface only', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(
        ({ publicPath }) => publicPath === 'previewContextMenu.onRequested'
      )
    ).toMatchObject({
      kind: 'event',
      channel: 'preview-context-menu:requested',
      surfaceInstallation: {
        electron: 'preload',
        localWeb: 'unavailable',
        remoteWeb: 'unavailable'
      },
      dispatchPolicy: {
        electron: 'electron-ipc-subscription',
        localWeb: 'none',
        remoteWeb: 'none'
      },
      mapProjection: 'none'
    })
  })

  it('publishes the complete Memory capability from the typed renderer contract', () => {
    const memory = RENDERER_CONTRACT_GROUPS.find(({ capability }) => capability === 'memory')

    expect(
      memory?.contracts.map(({ publicPath, channel, kind, applicationCommand }) => ({
        publicPath,
        channel,
        kind,
        applicationCommand
      }))
    ).toEqual([
      {
        publicPath: 'memory.clearAll',
        channel: 'memory:clear-all',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.createCategory',
        channel: 'memory:create-category',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.createEntry',
        channel: 'memory:create-entry',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.deleteCategory',
        channel: 'memory:delete-category',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.deleteEntry',
        channel: 'memory:delete-entry',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.onChanged',
        channel: 'memory:changed',
        kind: 'event',
        applicationCommand: undefined
      },
      {
        publicPath: 'memory.setEnabled',
        channel: 'memory:set-enabled',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.snapshot',
        channel: 'memory:snapshot',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.updateCategory',
        channel: 'memory:update-category',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      },
      {
        publicPath: 'memory.updateEntry',
        channel: 'memory:update-entry',
        kind: 'method',
        applicationCommand: 'runtime-validated'
      }
    ])
  })

  it('marks the runtime-validated command slice', () => {
    expect(paths(({ applicationCommand }) => applicationCommand === 'runtime-validated')).toEqual([
      'acp.respondPlan',
      'acp.respondToElicitation',
      'acp.respondToPermission',
      'memory.clearAll',
      'memory.createCategory',
      'memory.createEntry',
      'memory.deleteCategory',
      'memory.deleteEntry',
      'memory.setEnabled',
      'memory.snapshot',
      'memory.updateCategory',
      'memory.updateEntry',
      'projects.create',
      'projects.delete',
      'projects.get',
      'projects.list',
      'projects.listDeletionCleanup',
      'projects.retryDeletionCleanup',
      'projects.update',
      'projects.updateArchive',
      'sessions.deleteSession',
      'sessions.editDetails',
      'sessions.filterPdfContextCandidates',
      'sessions.linkPdfContext',
      'sessions.setDelegationPolicy',
      'sessions.unlinkPdfContext',
      'sessions.updateArchive',
      'tags.create',
      'tags.delete',
      'tags.reorder',
      'tags.setAssignment',
      'tags.snapshot',
      'tags.update',
      'uploads.finalizeSession'
    ])
    expect(ELECTRON_APPLICATION_COMMAND_CHANNELS).toEqual([
      'acp:respond-elicitation',
      'acp:respond-permission',
      'acp:respond-plan',
      'memory:clear-all',
      'memory:create-category',
      'memory:create-entry',
      'memory:delete-category',
      'memory:delete-entry',
      'memory:set-enabled',
      'memory:snapshot',
      'memory:update-category',
      'memory:update-entry',
      'projects:create',
      'projects:delete',
      'projects:get',
      'projects:list',
      'projects:list-deletion-cleanup',
      'projects:retry-deletion-cleanup',
      'projects:update',
      'projects:update-archive',
      'sessions:delete-session',
      'sessions:edit-details',
      'sessions:filter-pdf-context-candidates',
      'sessions:link-pdf-context',
      'sessions:set-delegation-policy',
      'sessions:unlink-pdf-context',
      'sessions:update-archive',
      'tags:create',
      'tags:delete',
      'tags:reorder',
      'tags:set-assignment',
      'tags:snapshot',
      'tags:update',
      'uploads:finalize-session'
    ])
  })
})
