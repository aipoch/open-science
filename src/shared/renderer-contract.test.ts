import { describe, expect, it } from 'vitest'

import {
  composeRendererContractCatalog,
  defineRendererContractGroup,
  projectRendererContractMaps,
  type RendererContractSeed
} from './renderer-contract'

const seed = (publicPath: string, channel: string): RendererContractSeed => ({
  publicPath,
  channel,
  kind: 'method',
  parameterCodec: { electron: 'positional', web: 'positional' },
  surfaceInstallation: { electron: 'preload', localWeb: 'web-rpc', remoteWeb: 'web-rpc' },
  dispatchPolicy: {
    electron: 'electron-ipc-request',
    localWeb: 'direct-application-request',
    remoteWeb: 'direct-application-request'
  },
  eventDeliverability: {
    electron: 'not-event',
    localWeb: 'not-event',
    remoteWeb: 'not-event'
  },
  authorityFlow: {
    electron: 'electron-sender',
    localWeb: 'caller-context',
    remoteWeb: 'caller-context'
  },
  mapProjection: 'invoke'
})

describe('renderer contract composition', () => {
  it('builds a deterministic deeply immutable catalog and projections', () => {
    const second = defineRendererContractGroup('projects', [seed('projects.list', 'projects:list')])
    const first = defineRendererContractGroup('acp', [
      {
        ...seed('acp.cancel', 'acp:cancel'),
        lifecycleDispatch: {
          activateChannel: 'acp:ready',
          activate: 'after-subscribe',
          deactivateChannel: 'acp:unready',
          deactivate: 'after-unsubscribe'
        }
      }
    ])
    const catalog = composeRendererContractCatalog([second, first])
    const projection = projectRendererContractMaps(catalog)

    expect(catalog.map(({ publicPath }) => publicPath)).toEqual(['acp.cancel', 'projects.list'])
    expect(projection.invoke).toEqual({
      'acp.cancel': 'acp:cancel',
      'projects.list': 'projects:list'
    })
    expect(projection.event).toEqual({})
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.contracts)).toBe(true)
    expect(Object.isFrozen(first.contracts[0])).toBe(true)
    expect(Object.isFrozen(first.contracts[0].surfaceInstallation)).toBe(true)
    expect(Object.isFrozen(first.contracts[0].lifecycleDispatch)).toBe(true)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(projection.invoke)).toBe(true)
  })

  it('rejects duplicate capabilities, public paths, and channels', () => {
    expect(() =>
      composeRendererContractCatalog([
        defineRendererContractGroup('same', [seed('first.path', 'first:channel')]),
        defineRendererContractGroup('same', [seed('second.path', 'second:channel')])
      ])
    ).toThrow('Duplicate renderer contract capability: same')

    expect(() =>
      composeRendererContractCatalog([
        defineRendererContractGroup('first', [seed('shared.path', 'first:channel')]),
        defineRendererContractGroup('second', [seed('shared.path', 'second:channel')])
      ])
    ).toThrow('Duplicate renderer contract path: shared.path')

    expect(() =>
      composeRendererContractCatalog([
        defineRendererContractGroup('first', [seed('first.path', 'shared:channel')]),
        defineRendererContractGroup('second', [seed('second.path', 'shared:channel')])
      ])
    ).toThrow('Duplicate renderer contract channel: shared:channel')

    expect(() =>
      composeRendererContractCatalog([
        defineRendererContractGroup('first', [
          {
            ...seed('first.path', 'first:channel'),
            lifecycleDispatch: {
              activateChannel: 'shared:lifecycle-channel',
              activate: 'on-call',
              deactivateChannel: 'first:unready',
              deactivate: 'on-dispose'
            }
          }
        ]),
        defineRendererContractGroup('second', [seed('second.path', 'shared:lifecycle-channel')])
      ])
    ).toThrow('Duplicate renderer contract channel: shared:lifecycle-channel')
  })

  it('copies nested profiles before freezing declarations', () => {
    const mutable = {
      ...seed('projects.list', 'projects:list'),
      lifecycleDispatch: {
        activateChannel: 'projects:ready',
        activate: 'on-call' as const,
        deactivateChannel: 'projects:unready',
        deactivate: 'on-dispose' as const
      }
    } as {
      publicPath: string
      surfaceInstallation: { localWeb: string }
      lifecycleDispatch: { activateChannel: string }
    }
    const group = defineRendererContractGroup('projects', [mutable as RendererContractSeed])
    mutable.publicPath = 'projects.changed'
    mutable.surfaceInstallation.localWeb = 'changed'
    mutable.lifecycleDispatch.activateChannel = 'changed'

    expect(group.contracts[0].publicPath).toBe('projects.list')
    expect(group.contracts[0].surfaceInstallation.localWeb).toBe('web-rpc')
    expect(group.contracts[0].lifecycleDispatch?.activateChannel).toBe('projects:ready')
  })
})
