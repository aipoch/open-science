import { Agent, buildConnector, fetch as nodeFetch } from 'undici'
import { connect as connectTls } from 'node:tls'
import { resolveParentProxyUrl, tunnelThroughProxy } from '@aipoch/notebook-network-sandbox'
import type { RuntimeNetwork } from './runtime-network'

type ProxyEnvironment = { http?: string; https?: string; noProxy?: string }

// Node's system mode uses the launch environment. Native PAC, profile cookies and integrated
// Chromium authentication belong to the desktop host; no guessed proxy or credential fallback.
export function createNodeRuntimeNetwork(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeNetwork & { close(): Promise<void> } {
  const inherited: ProxyEnvironment = {
    http:
      environment.http_proxy ||
      environment.HTTP_PROXY ||
      environment.all_proxy ||
      environment.ALL_PROXY,
    https:
      environment.https_proxy ||
      environment.HTTPS_PROXY ||
      environment.all_proxy ||
      environment.ALL_PROXY,
    noProxy: environment.no_proxy || environment.NO_PROXY
  }
  const direct = buildConnector({ timeout: 30_000 })
  const agents = new Set<Agent>()
  let settings = inherited
  const createAgent = (proxySettings: ProxyEnvironment): Agent => {
    const agent = new Agent({
      connect(options, callback) {
        const target = new URL(`${options.protocol}//${options.host || options.hostname}`)
        if (options.port) target.port = options.port
        const proxy = resolveParentProxyUrl(proxySettings, target)
        if (!proxy) {
          direct(options, callback)
          return
        }
        const controller = new AbortController()
        const signal = controller.signal
        const timer = setTimeout(
          () => controller.abort(new Error('Proxy connection timed out.')),
          30_000
        )
        let settled = false
        const finish: typeof callback = (...args) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          callback(...args)
        }
        void tunnelThroughProxy(
          proxy,
          options.hostname,
          Number(options.port || (options.protocol === 'https:' ? 443 : 80)),
          undefined,
          signal
        ).then(
          (socket) => {
            if (options.protocol !== 'https:') {
              finish(null, socket)
              return
            }
            const tls = connectTls({
              socket,
              servername: options.servername || options.hostname,
              ALPNProtocols: ['http/1.1']
            })
            const failed = (error: Error): void => {
              tls.destroy()
              finish(error, null)
            }
            const abort = (): void => failed(new Error('Proxy TLS handshake timed out.'))
            tls.once('error', failed)
            signal.addEventListener('abort', abort, { once: true })
            tls.once('close', () => signal.removeEventListener('abort', abort))
            tls.once('secureConnect', () => {
              tls.removeListener('error', failed)
              signal.removeEventListener('abort', abort)
              finish(null, tls)
            })
          },
          (error: unknown) =>
            finish(error instanceof Error ? error : new Error(String(error)), null)
        )
      }
    })
    agents.add(agent)
    return agent
  }
  let agent = createAgent(settings)
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // Keep redirects, header stripping, streaming, request cancellation and TLS verification in
    // Undici. Normalize native Request objects rather than relying on cross-package instanceof.
    const request = new Request(input, init)
    return (await nodeFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body as never,
      duplex: 'half',
      redirect: request.redirect,
      signal: request.signal,
      dispatcher: agent
    })) as unknown as Response
  }
  return {
    fetch,
    fetchWithManualRedirect: fetch,
    resolveProxy: async (url) => {
      const proxy = resolveParentProxyUrl(settings, new URL(url))
      if (!proxy) return 'DIRECT'
      // Chromium's directive format cannot carry authentication; fail explicitly so existing
      // process-environment fallback retains credentials without leaking them in a directive.
      if (proxy.username || proxy.password)
        throw new Error('Authenticated proxy requires the inherited proxy environment.')
      const kind = proxy.protocol.startsWith('socks')
        ? proxy.protocol === 'socks4:'
          ? 'SOCKS4'
          : 'SOCKS5'
        : proxy.protocol === 'https:'
          ? 'HTTPS'
          : 'PROXY'
      return `${kind} ${proxy.host}`
    },
    setProxy: async (config) => {
      if (!['system', 'direct', 'fixed_servers'].includes(config.mode ?? ''))
        throw new Error(
          'Node backend supports environment, direct and fixed proxy settings; PAC requires the desktop app.'
        )
      const next =
        config.mode === 'system'
          ? inherited
          : config.mode === 'direct'
            ? {}
            : {
                http: config.proxyRules,
                https: config.proxyRules,
                noProxy: config.proxyBypassRules?.replace(/<local>/g, 'localhost')
              }
      // Validate before publishing, retaining the previous transport on invalid configuration.
      resolveParentProxyUrl(next, new URL('https://open-science.invalid'))
      const previous = agent
      agent = createAgent(next)
      settings = next
      void previous
        .close()
        .finally(() => agents.delete(previous))
        .catch(() => undefined)
    },
    close: async () => {
      await Promise.all([...agents].map((value) => value.destroy()))
      agents.clear()
    }
  }
}
