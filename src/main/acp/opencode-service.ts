import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { terminateProcessTree, type ProcessTreeKillResult } from '../process-tree'
import { spawnOpenCodeProcess } from '../agent-framework/opencode'
import type { AgentProcessSpawner, ResolvedAgentBackend } from '../agent-framework'
import { spawnMainAgentProcess } from './main-agent-process-ownership'

export class OpenCodeServiceCleanupError extends Error {}

export type OpenCodeServiceLease = Readonly<{
  release: () => Promise<ProcessTreeKillResult>
}>

// 2.x ACP owns a private server. A separate public service admits inbox inputs with resume:false
// and reads context from the same isolated store; it must never become a second prompt runner.
export const startOpenCodeService = async (
  backend: ResolvedAgentBackend,
  onUnexpectedExit: () => void,
  spawnProcess?: AgentProcessSpawner
): Promise<
  OpenCodeServiceLease & { api: NonNullable<ResolvedAgentBackend['opencodeUsageApi']> }
> => {
  const password = randomUUID()
  const start = (spawnProcess: AgentProcessSpawner | undefined): ReturnType<AgentProcessSpawner> =>
    spawnOpenCodeProcess(
      {
        executablePath: backend.executablePath,
        env: { ...backend.env, OPENCODE_PASSWORD: password, OPENCODE_USERNAME: 'opencode' },
        args: ['--stdio', '--port', '0', '--hostname', '127.0.0.1'],
        proxyEnvironmentMode: backend.proxyEnvironmentMode,
        spawnProcess
      },
      'serve'
    )
  const child = spawnProcess
    ? start(spawnProcess)
    : await spawnMainAgentProcess(backend.framework.id, start)
  let stopping = false
  let released: Promise<ProcessTreeKillResult> | undefined
  const release = (): Promise<ProcessTreeKillResult> => {
    if (released) return released
    stopping = true
    // Keep the leader alive until tree termination settles. Ending the stdio lifetime lease
    // first lets serve exit before tree termination can discover and confirm its descendants.
    released ??= terminateProcessTree(child).finally(() => child.stdin.end())
    return released
  }
  // Drain diagnostics without retaining config/provider secrets in a startup error.
  child.stderr.resume()
  child.stdin.on('error', () => undefined)
  let ready = false
  let reportedExit = false
  const reportExit = (): void => {
    if (!ready || stopping || reportedExit) return
    reportedExit = true
    onUnexpectedExit()
  }
  child.on('exit', reportExit)
  child.on('error', reportExit)
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let buffer = ''
      const decoder = new StringDecoder('utf8')
      const finish = (error?: Error, url?: string): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
        if (error) reject(error)
        else {
          ready = true
          resolve(url!)
        }
      }
      const onError = (): void => finish(new Error('OpenCode HTTP service failed to start.'))
      const onExit = (): void =>
        finish(new Error('OpenCode HTTP service exited before becoming ready.'))
      const onData = (chunk: Buffer): void => {
        buffer += decoder.write(chunk)
        if (buffer.length > 65_536)
          return finish(new Error('Invalid OpenCode HTTP service startup response.'))
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          try {
            const record: unknown = JSON.parse(line)
            if (
              !record ||
              typeof record !== 'object' ||
              !('url' in record) ||
              typeof record.url !== 'string'
            )
              continue
            const url = new URL(record.url)
            if (
              url.protocol !== 'http:' ||
              url.hostname !== '127.0.0.1' ||
              !url.port ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            ) {
              finish(
                new Error('OpenCode HTTP service did not bind to the expected loopback address.')
              )
              return
            }
            finish(undefined, url.origin)
            return
          } catch {
            // Ignore non-readiness log lines; the bounded startup timer still applies.
          }
        }
      }
      const timer = setTimeout(
        () => finish(new Error('OpenCode HTTP service startup timed out.')),
        10_000
      )
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
    child.stdout.resume()
    return {
      api: {
        baseUrl,
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        version: 2
      },
      release
    }
  } catch (error) {
    const result = await release().catch((cause) => {
      throw new OpenCodeServiceCleanupError('OpenCode HTTP service cleanup failed.', { cause })
    })
    if (!result.reaped)
      throw new OpenCodeServiceCleanupError(
        'OpenCode HTTP service could not be stopped after startup failed.',
        { cause: error }
      )
    throw error
  }
}
