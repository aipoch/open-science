import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import * as acp from '@agentclientprotocol/sdk'
import type { CodeBuddySite } from '../../shared/codebuddy-subscription'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../process-tree'
import { codeBuddyAccountEnvironment, codeBuddyHostEnvironment } from './codebuddy-profile'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'

type AccountSnapshot = { authenticated: boolean; model?: string; models?: string[] }

// Keep credentials and vendor auth responses on the CLI side of the settings IPC boundary.
export async function runCodeBuddyAuth(
  executable: string,
  storageRoot: string,
  site: CodeBuddySite,
  action: 'login' | 'status' | 'logout',
  cancel?: AbortSignal
): Promise<AccountSnapshot> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(action === 'login' ? 330_000 : 20_000),
    ...(cancel ? [cancel] : [])
  ])
  const profile = codeBuddyAccountEnvironment(storageRoot, site)
  await mkdir(profile.CODEBUDDY_CONFIG_DIR, { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
  const logout = action === 'logout'
  const args = logout
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    : ['--acp', '--strict-mcp-config', '--setting-sources', 'user']
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const child = spawn(shell ? `"${executable}"` : executable, args, {
    cwd: profile.HOME,
    env: { ...codeBuddyHostEnvironment(process.env), ...profile },
    shell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'pipe'
  })
  if (process.platform !== 'win32') registerOwnedPosixProcessGroup(child)
  child.stderr.resume()
  const aborted = (): void => {
    void terminateProcessTree(child)
  }
  signal.addEventListener('abort', aborted, { once: true })
  let close: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    child.stdin.once('error', reject)
    child.once('error', reject)
    child.once('close', () => reject(new Error('CodeBuddy authentication process closed.')))
  })
  try {
    const operate = async (): Promise<AccountSnapshot> => {
      if (logout) {
        const lines = createInterface({ input: child.stdout })
        try {
          child.stdin.write(
            JSON.stringify({
              type: 'control_request',
              request_id: 'logout',
              request: { subtype: 'logout', environment: site }
            }) + '\n'
          )
          for await (const line of lines) {
            const message = JSON.parse(line)
            if (message.type !== 'control_response' || message.response?.request_id !== 'logout')
              continue
            if (
              message.response.subtype !== 'success' ||
              message.response.response?.success !== true
            )
              throw new Error('CodeBuddy sign-out failed.')
            return { authenticated: false }
          }
        } finally {
          lines.close()
        }
        throw new Error('CodeBuddy sign-out did not finish.')
      }
      const connection = acp
        .client({ name: 'open-science-codebuddy-auth' })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
          )
        )
      close = () => connection.close()
      const init = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
      })
      const status = async (): Promise<boolean> =>
        Boolean(
          (
            await connection.agent.request<{ userInfo?: { userId?: string } }>(
              '_codebuddy.ai/getUserInfo',
              {}
            )
          ).userInfo?.userId
        )
      const authenticated = await status()
      if (action === 'status') return { authenticated }
      if (!authenticated) {
        if (!init.authMethods?.some((method) => method.id === site))
          throw new Error('CodeBuddy login method unavailable.')
        await connection.agent.request(acp.methods.agent.authenticate, { methodId: site })
        if (!(await status())) throw new Error('CodeBuddy sign-in did not complete.')
      }
      // CodeBuddy supplies the ACP legacy model catalog alongside standard configOptions.
      const session = await connection.agent.request<{
        models?: { currentModelId: string; availableModels?: { modelId: string }[] }
      }>('session/new', { cwd: profile.HOME, mcpServers: [] })
      const model = session.models?.currentModelId
      if (
        typeof model !== 'string' ||
        !model ||
        model.length > PROVIDER_RESOURCE_LIMITS.modelIdCharacters
      )
        throw new Error('CodeBuddy did not return an account model.')
      const models = [
        ...new Set([model, ...(session.models?.availableModels ?? []).map((m) => m.modelId)])
      ]
        .filter(
          (id) =>
            typeof id === 'string' && id && id.length <= PROVIDER_RESOURCE_LIMITS.modelIdCharacters
        )
        .slice(0, PROVIDER_RESOURCE_LIMITS.fetchedModels)
      return { authenticated: true, model, models }
    }
    return await Promise.race([operate(), stopped])
  } catch {
    signal.throwIfAborted()
    // Vendor errors can contain the auth URL or account details. Keep them out of IPC.
    throw new Error('CodeBuddy account request failed.')
  } finally {
    signal.removeEventListener('abort', aborted)
    close?.()
    child.stdin.end()
    await terminateProcessTree(child)
  }
}
