import { createLogger } from '@aipoch/diagnostics/node'
import { Agent, buildConnector, fetch as nodeFetch } from 'undici'
import { connect as connectTls } from 'node:tls'
import type { Socket } from 'node:net'
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
  const lifetime = new AbortController()
  const connectingSockets = new Map<Socket, Promise<void>>()
  const proxyConnections = new Set<AbortController>()
  const connectionCompletions = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  const trackSocket = (socket: Socket): void => {
    if (socket.closed || connectingSockets.has(socket)) return
    const closed = new Promise<void>((resolve) => socket.once('close', resolve))
    connectingSockets.set(socket, closed)
    void closed.then(() => connectingSockets.delete(socket))
    if (lifetime.signal.aborted) socket.destroy(lifetime.signal.reason)
  }
  let settings = inherited
  const createAgent = (proxySettings: ProxyEnvironment): Agent => {
    const agent = new Agent({
      connect(options, callback) {
        if (lifetime.signal.aborted) {
          callback(new Error('Runtime network is closed.'), null)
          return
        }
        const target = new URL(`${options.protocol}//${options.host || options.hostname}`)
        if (options.port) target.port = options.port
        const proxy = resolveParentProxyUrl(proxySettings, target)
        if (!proxy) {
          let complete!: () => void
          const completion = new Promise<void>((resolve) => {
            complete = resolve
          })
          connectionCompletions.add(completion)
          let settled = false
          let delivered = false
          const finish: typeof callback = (error, socket) => {
            if (socket) trackSocket(socket)
            if (settled) {
              socket?.destroy()
              return
            }
            settled = true
            connectionCompletions.delete(completion)
            complete()
            if (lifetime.signal.aborted) {
              socket?.destroy()
              callback(error ?? new Error('Runtime network is closed.'), null)
            } else if (error) callback(error, null)
            else {
              delivered = true
              if (socket) connectingSockets.delete(socket)
              callback(null, socket!)
            }
          }
          try {
            // Undici's built-in connector returns the in-progress socket, although its
            // public connector type permits void for third-party implementations.
            const socket = direct(options, finish) as unknown as Socket | undefined
            if (socket) {
              if (!delivered) trackSocket(socket)
              const closed = (): void => {
                if (!settled)
                  finish(new Error('Connection closed before it was established.'), null)
              }
              if (socket.closed) closed()
              else socket.once('close', closed)
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)), null)
          }
          return
        }
        const controller = new AbortController()
        proxyConnections.add(controller)
        const signal = controller.signal
        const pendingSockets = new Set<Socket>()
        let complete!: () => void
        const completion = new Promise<void>((resolve) => {
          complete = resolve
        })
        connectionCompletions.add(completion)
        const timer = setTimeout(
          () => controller.abort(new Error('Proxy connection timed out.')),
          30_000
        )
        let settled = false
        const finish: typeof callback = (...args) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          proxyConnections.delete(controller)
          connectionCompletions.delete(completion)
          complete()
          if (!args[0]) for (const socket of pendingSockets) connectingSockets.delete(socket)
          callback(...args)
        }
        void tunnelThroughProxy(
          proxy,
          options.hostname,
          Number(options.port || (options.protocol === 'https:' ? 443 : 80)),
          undefined,
          signal,
          (socket) => {
            pendingSockets.add(socket)
            trackSocket(socket)
          }
        ).then(
          (socket) => {
            if (signal.aborted || lifetime.signal.aborted) {
              socket.destroy()
              finish(new Error('Runtime network is closed.'), null)
              return
            }
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
            finish(
              Object.assign(new Error('Proxy connection failed.', { cause: error }), {
                code: 'ERR_PROXY_CONNECTION_FAILED'
              }),
              null
            )
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
    lifetime.signal.throwIfAborted()
    const request = new Request(input, init)
    return (await nodeFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body as never,
      duplex: 'half',
      redirect: request.redirect,
      signal: AbortSignal.any([request.signal, lifetime.signal]),
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
      lifetime.signal.throwIfAborted()
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
    close: () =>
      (closing ??= (async () => {
        lifetime.abort(new Error('Runtime network is closed.'))
        // Undici can complete destroy() before a custom connector has returned its socket.
        // Those sockets and their timeout timers still belong to this network owner.
        for (const controller of proxyConnections) controller.abort(lifetime.signal.reason)
        for (const socket of connectingSockets.keys()) socket.destroy(lifetime.signal.reason)
        createLogger('network').info('shutdown destroy agents', {
          agents: agents.size,
          sockets: connectingSockets.size,
          connections: connectionCompletions.size
        })
        await Promise.all([...agents].map((value) => value.destroy()))
        createLogger('network').info('shutdown agents destroyed', {
          sockets: connectingSockets.size,
          connections: connectionCompletions.size
        })
        await Promise.all([...connectingSockets.values()])
        createLogger('network').info('shutdown sockets closed', {
          connections: connectionCompletions.size
        })
        await Promise.all([...connectionCompletions])
        agents.clear()
      })())
  }
}
