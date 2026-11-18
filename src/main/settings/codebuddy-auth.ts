import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import * as acp from '@agentclientprotocol/sdk'
import type {
  CodeBuddyAccountRequest,
  CodeBuddyAuthMode,
  CodeBuddySite
} from '../../shared/codebuddy-subscription'
import { collectSelectValues } from '../../shared/acp-select-options'
import {
  createPosixProcessTreeOwnership,
  terminateProcessTree,
  trackOwnedPosixProcessTree
} from '../process-tree'
import {
  codeBuddyAccountEnvironment,
  codeBuddyHostEnvironment,
  sharedCodeBuddySiteMatches
} from './codebuddy-profile'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'

type AccountSnapshot = { authenticated: boolean; model?: string; models?: string[] }

// Keep credentials and vendor auth responses on the CLI side of the settings IPC boundary.
export async function runCodeBuddyAuth(
  executable: string,
  storageRoot: string,
  site: CodeBuddySite,
  action: Exclude<CodeBuddyAccountRequest['action'], 'cancel'>,
  cancel?: AbortSignal,
  mode: CodeBuddyAuthMode = 'isolated'
): Promise<AccountSnapshot> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(action === 'login' ? 330_000 : 20_000),
    ...(cancel ? [cancel] : [])
  ])
  if (mode === 'shared') {
    if (action === 'logout')
      throw new Error('Disconnect the shared CodeBuddy provider from Open-Science.')
    if (!sharedCodeBuddySiteMatches(site)) return { authenticated: false }
  }
  const profile = codeBuddyAccountEnvironment(storageRoot, site, mode)
  const cwd = mode === 'shared' ? profile.CODEBUDDY_CONFIG_DIR : profile.HOME
  await mkdir(profile.CODEBUDDY_CONFIG_DIR, { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
  const logout = action === 'logout'
  const args = logout
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    : ['--acp', '--strict-mcp-config', '--setting-sources', 'user']
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const ownership = createPosixProcessTreeOwnership({
    ...codeBuddyHostEnvironment(process.env),
    ...profile
  })
  const child = spawn(shell ? `"${executable}"` : executable, args, {
    cwd,
    env: ownership.env,
    shell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'pipe'
  })
  if (process.platform !== 'win32') trackOwnedPosixProcessTree(child, ownership.token)
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
  let accountVerified = false
  let catalogTimeout: ReturnType<typeof setTimeout> | undefined
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
      if (action === 'status' || ((action === 'refresh' || mode === 'shared') && !authenticated))
        return { authenticated }
      if (!authenticated) {
        if (!init.authMethods?.some((method) => method.id === site))
          throw new Error('CodeBuddy login method unavailable.')
        await connection.agent.request(acp.methods.agent.authenticate, { methodId: site })
        if (!(await status())) throw new Error('CodeBuddy sign-in did not complete.')
      }
      accountVerified = true
      const session = await Promise.race([
        connection.agent.request<
          acp.NewSessionResponse & {
            models?: { currentModelId?: string; availableModels?: { modelId: string }[] }
          }
        >('session/new', { cwd, mcpServers: [] }),
        new Promise<never>((_, reject) => {
          catalogTimeout = setTimeout(
            () => reject(new Error('CodeBuddy model discovery timed out.')),
            10_000
          )
        })
      ])
      const option = session.configOptions?.find(
        (entry) => entry.type === 'select' && (entry.category === 'model' || entry.id === 'model')
      )
      const select = option?.type === 'select' ? option : undefined
      const validId = (id: unknown): id is string =>
        typeof id === 'string' &&
        !!id.trim() &&
        id.length <= PROVIDER_RESOURCE_LIMITS.modelIdCharacters
      const values = collectSelectValues(select?.options).filter(validId)
      const ids = values.length
        ? values
        : (session.models?.availableModels ?? []).map((m) => m?.modelId).filter(validId)
      if (!ids.length) return { authenticated: true }
      const current = values.length ? select?.currentValue : session.models?.currentModelId
      const model = current && ids.includes(current) ? current : ids[0]
      const models = [...new Set([model, ...ids])].slice(0, PROVIDER_RESOURCE_LIMITS.fetchedModels)
      return { authenticated: true, model, models }
    }
    return await Promise.race([operate(), stopped])
  } catch {
    cancel?.throwIfAborted()
    // A catalog error after verified sign-in must not discard the account or a prior catalog.
    if (accountVerified) return { authenticated: true }
    signal.throwIfAborted()
    // Vendor errors can contain the auth URL or account details. Keep them out of IPC.
    throw new Error('CodeBuddy account request failed.')
  } finally {
    clearTimeout(catalogTimeout)
    signal.removeEventListener('abort', aborted)
    close?.()
    child.stdin.end()
    await terminateProcessTree(child)
  }
}
