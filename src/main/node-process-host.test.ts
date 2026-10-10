import { DesktopCapabilityUnavailable } from './desktop-interaction'
import { toApplicationCommandErrorEnvelope } from '../shared/application-command-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeRuntimeEnvironment, nodeRuntimeEnvironmentEntries } from './node-process-host'
import { isRuntimeHelper } from './runtime-helper'

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
    const values = nodeRuntimeEnvironment()
    expect(values).toEqual({
      ELECTRON_RUN_AS_NODE: electron ? '1' : undefined,
      OPEN_SCIENCE_HOST_HOME: '/fixture/home',
      OPEN_SCIENCE_APPLICATION_PATH: '/fixture/app',
      OPEN_SCIENCE_RESOURCES_PATH: '/fixture/resources',
      OPEN_SCIENCE_APPLICATION_VERSION: '0.35.1',
      OPEN_SCIENCE_HOST_PACKAGED: '0'
    })
    expect(nodeRuntimeEnvironmentEntries()).toContainEqual({
      name: 'OPEN_SCIENCE_HOST_PACKAGED',
      value: '0'
    })
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
})
