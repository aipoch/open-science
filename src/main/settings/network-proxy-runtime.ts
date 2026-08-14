import type { ProxyConfig } from 'electron'

import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  resolveNetworkProxySettings,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import {
  SYSTEM_PROXY_ENV_KEYS,
  clearSystemProxyEnvironment,
  loopbackProxyBypassEnvironment,
  type SystemProxyEnvironment
} from './system-proxy'

type NetworkProxyRuntimeOptions = Readonly<{
  environment?: NodeJS.ProcessEnv
  setProxy: (config: ProxyConfig) => Promise<void>
}>

const captureProxyEnvironment = (environment: NodeJS.ProcessEnv): SystemProxyEnvironment => {
  const captured: SystemProxyEnvironment = {}
  for (const key of SYSTEM_PROXY_ENV_KEYS) {
    const value = environment[key]
    if (value !== undefined) captured[key] = value
  }
  return captured
}

const hasProxyServer = (environment: SystemProxyEnvironment): boolean =>
  ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some((key) =>
    Boolean(environment[key as keyof SystemProxyEnvironment])
  )

const withLoopbackBypass = (
  environment: SystemProxyEnvironment,
  sourceEnvironment: NodeJS.ProcessEnv
): SystemProxyEnvironment =>
  hasProxyServer(environment)
    ? {
        ...environment,
        ...loopbackProxyBypassEnvironment({ ...sourceEnvironment, ...environment })
      }
    : environment

const manualProxyEnvironment = (settings: NetworkProxySettings): SystemProxyEnvironment => {
  if (settings.mode !== 'manual' || !settings.server) return {}
  const bypassSource = settings.bypassRules
    ? { NO_PROXY: settings.bypassRules, no_proxy: settings.bypassRules }
    : {}
  const bypass = loopbackProxyBypassEnvironment(bypassSource)

  return {
    HTTP_PROXY: settings.server,
    HTTPS_PROXY: settings.server,
    ALL_PROXY: settings.server,
    http_proxy: settings.server,
    https_proxy: settings.server,
    all_proxy: settings.server,
    ...bypass
  }
}

const manualProxyConfig = (
  settings: NetworkProxySettings,
  environment: SystemProxyEnvironment
): ProxyConfig => ({
  mode: 'fixed_servers',
  proxyRules: settings.server,
  proxyBypassRules: ['<local>', environment.NO_PROXY].filter(Boolean).join(',')
})

// Projects the persisted Network preference into the two network stacks Open Science owns:
// Electron's Chromium Session and the environment inherited by processes started after the change.
// It never changes the operating-system proxy and never restarts an already-running process.
export class NetworkProxyRuntime {
  private readonly environment: NodeJS.ProcessEnv
  private readonly inheritedEnvironment: SystemProxyEnvironment
  private readonly setProxy: (config: ProxyConfig) => Promise<void>
  private childProcessEnvironment: SystemProxyEnvironment | undefined
  private settings: NetworkProxySettings = DEFAULT_NETWORK_PROXY_SETTINGS

  constructor(options: NetworkProxyRuntimeOptions) {
    this.environment = options.environment ?? process.env
    this.inheritedEnvironment = captureProxyEnvironment(this.environment)
    this.setProxy = options.setProxy
    this.childProcessEnvironment = hasProxyServer(this.inheritedEnvironment)
      ? withLoopbackBypass(this.inheritedEnvironment, this.inheritedEnvironment)
      : undefined
  }

  getSettings(): NetworkProxySettings {
    return { ...this.settings }
  }

  getChildProcessProxyEnvironment(): SystemProxyEnvironment | undefined {
    return this.childProcessEnvironment === undefined
      ? undefined
      : { ...this.childProcessEnvironment }
  }

  async apply(value: unknown): Promise<NetworkProxySettings> {
    const settings = resolveNetworkProxySettings(value)
    let environment: SystemProxyEnvironment

    if (settings.mode === 'manual') {
      environment = manualProxyEnvironment(settings)
      await this.setProxy(manualProxyConfig(settings, environment))
    } else if (settings.mode === 'direct') {
      environment = {}
      await this.setProxy({ mode: 'direct' })
    } else {
      await this.setProxy({ mode: 'system' })
      environment = withLoopbackBypass(this.inheritedEnvironment, this.inheritedEnvironment)
    }

    clearSystemProxyEnvironment(this.environment)
    Object.assign(this.environment, environment)
    this.childProcessEnvironment =
      settings.mode === 'system' && !hasProxyServer(environment) ? undefined : environment
    this.settings = settings
    return this.getSettings()
  }
}

export { captureProxyEnvironment, manualProxyEnvironment, manualProxyConfig }
