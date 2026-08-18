import { randomUUID } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import type { ComputeHost } from '../../shared/compute'
import {
  ComputeConnectionError,
  classifyConnectionFailure,
  type AcquireComputeConnectionRequest,
  type ComputeConnectionAdapter,
  type ComputeConnectionLease
} from './connection-broker'
import type { CredentialVault } from './credential-vault'
import {
  buildScpUploadArgs,
  resolveScpBinary,
  type BoundedScpResult,
  type ScpRunner
} from './scp-runner'
import {
  resolveSshTarget,
  readEffectiveConfig,
  resolveSshBinary,
  SystemSshRunner,
  type ResolvedSshTarget,
  type SshRunner
} from './ssh-runner'

type AskpassEnvironment = Readonly<{
  env: NodeJS.ProcessEnv
  wasAnswered(): boolean
  wasUnsupportedPromptRejected?(): boolean
  dispose(): Promise<void>
}>

type PreparedPasswordTarget = Readonly<{
  target: ResolvedSshTarget
  expectedAccounts: readonly string[]
}>

const PASSWORD_POLICY_OPTIONS = new Set([
  'batchmode',
  'controlmaster',
  'controlpath',
  'controlpersist',
  'forwardagent',
  'identitiesonly',
  'identityagent',
  'identityfile',
  'kbdinteractiveauthentication',
  'numberofpasswordprompts',
  'passwordauthentication',
  'preferredauthentications',
  'proxycommand',
  'proxyjump',
  'pubkeyauthentication',
  'stricthostkeychecking'
])

const withoutInheritedAuthenticationOptions = (args: readonly string[]): string[] => {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '-i') {
      index += 1
      continue
    }
    if (argument === '-o') {
      const option = args[index + 1]
      const name = option?.split('=', 1)[0]?.toLowerCase()
      if (name && PASSWORD_POLICY_OPTIONS.has(name)) {
        index += 1
        continue
      }
    }
    result.push(argument)
  }
  return result
}

const askpassResourcePath = (name: string): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', name)
    : join(app.getAppPath(), 'resources', name)

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const hasHostUnreachableDiagnostic = (stderr: string): boolean => {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('connection refused') ||
    normalized.includes('network is unreachable') ||
    normalized.includes('no route to host') ||
    normalized.includes('could not resolve hostname')
  )
}

const classifyPasswordConnectionFailure = (
  result: { exitCode: number | null; stderr: string; timedOut: boolean },
  askpass: AskpassEnvironment
): ComputeConnectionError | undefined => {
  const failure = classifyConnectionFailure(result)
  if (!failure || !askpass.wasUnsupportedPromptRejected?.()) return failure
  if (
    failure.code === 'authentication_failed' ||
    (failure.code === 'host_unreachable' && !hasHostUnreachableDiagnostic(result.stderr))
  ) {
    return new ComputeConnectionError('unsupported_auth_configuration')
  }
  return failure
}

// Password-mode children receive only the operating-system context needed to locate OpenSSH,
// resolve the user's SSH configuration/known_hosts, and create temporary files. Copying the whole
// parent environment would turn every unrelated application secret into a generic child variable.
const askpassBaseEnvironment = (): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME'
  ]) {
    const value = process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

const createAskpassEnvironment = async (
  password: string,
  expectedAccounts: readonly string[] = []
): Promise<AskpassEnvironment> => {
  if (platform() === 'win32') throw new ComputeConnectionError('unsupported_auth_configuration')
  const capability = randomUUID()
  const socketPath = join(tmpdir(), `os-askpass-${randomUUID()}.sock`)
  let answered = false
  let unsupportedPromptRejected = false
  const server = createServer((socket) => {
    let request = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      request += chunk
    })
    socket.on('end', () => {
      try {
        const payload = JSON.parse(request) as { capability?: string; prompt?: string }
        const prompt = payload.prompt ?? ''
        const rejected = /passphrase|keyboard|interactive|verification|one[- ]?time|otp|mfa|proxy/i
        const targetPasswordPrompt = expectedAccounts.some((account) =>
          new RegExp(`^${escapeRegExp(account)}'s password:\\s*$`, 'i').test(prompt)
        )
        if (payload.capability !== capability) {
          socket.end('{}')
          return
        }
        if (answered || !targetPasswordPrompt || rejected.test(prompt)) {
          unsupportedPromptRejected = true
          socket.end('{}')
          return
        }
        answered = true
        socket.end(JSON.stringify({ password }))
      } catch {
        socket.end('{}')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    await chmod(socketPath, 0o600)
  } catch {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(socketPath, { force: true })
    throw new ComputeConnectionError('credential_unavailable')
  }
  return {
    env: {
      ...askpassBaseEnvironment(),
      LANG: 'C',
      LC_ALL: 'C',
      DISPLAY: process.env.DISPLAY || 'open-science-askpass',
      SSH_ASKPASS_REQUIRE: 'force',
      SSH_ASKPASS: askpassResourcePath('compute-askpass.sh'),
      OPEN_SCIENCE_ASKPASS_RUNTIME: process.execPath,
      OPEN_SCIENCE_ASKPASS_MODULE: askpassResourcePath('compute-askpass.cjs'),
      OPEN_SCIENCE_ASKPASS_SOCKET: socketPath,
      OPEN_SCIENCE_ASKPASS_CAPABILITY: capability,
      ELECTRON_RUN_AS_NODE: '1'
    },
    wasAnswered: () => answered,
    wasUnsupportedPromptRejected: () => unsupportedPromptRejected,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
    }
  }
}

class PasswordSshAdapter implements ComputeConnectionAdapter {
  constructor(
    private readonly vault: CredentialVault,
    private readonly runner: SshRunner = new SystemSshRunner(),
    private readonly resolveTarget: typeof resolveSshTarget = resolveSshTarget,
    private readonly readConfig: (alias: string) => Promise<Record<string, string>> = (alias) =>
      readEffectiveConfig(alias, resolveSshBinary()),
    private readonly createAskpass: (
      password: string,
      expectedAccounts?: readonly string[]
    ) => Promise<AskpassEnvironment> = createAskpassEnvironment,
    private readonly scpRunner?: ScpRunner
  ) {}

  async acquire(
    host: ComputeHost,
    request: AcquireComputeConnectionRequest
  ): Promise<ComputeConnectionLease> {
    const target = await this.prepareTarget(host, request.signal)
    const credentialLease = await this.vault.acquirePasswordLease(
      host.id,
      host.authentication?.revision
    )
    const withLease = <Result>(
      operation: (lease: ComputeConnectionLease) => Promise<Result>
    ): Promise<Result> =>
      credentialLease.withPassword(async (password) => {
        const lease = await this.acquirePreparedWithPassword(host, password, request, target)
        return operation(lease)
      })
    return {
      run: (command, options) => withLease((lease) => lease.run(command, options)),
      upload: (localPath, remotePath) => withLease((lease) => lease.upload(localPath, remotePath)),
      download: (remotePath, localPath, maxBytes) =>
        withLease((lease) => lease.download(remotePath, localPath, maxBytes))
    }
  }

  async acquireWithPassword(
    host: ComputeHost,
    password: string,
    request: AcquireComputeConnectionRequest
  ): Promise<ComputeConnectionLease> {
    return this.acquirePreparedWithPassword(
      host,
      password,
      request,
      await this.prepareTarget(host, request.signal)
    )
  }

  private async acquirePreparedWithPassword(
    host: ComputeHost,
    password: string,
    request: AcquireComputeConnectionRequest,
    prepared: PreparedPasswordTarget
  ): Promise<ComputeConnectionLease> {
    const base = prepared.target
    const target = {
      ...base,
      extraArgs: [
        ...base.extraArgs,
        '-o',
        'BatchMode=no',
        '-o',
        'PasswordAuthentication=yes',
        '-o',
        'PreferredAuthentications=password',
        '-o',
        'NumberOfPasswordPrompts=1'
      ]
    }
    const withAskpass = async <Result>(
      operation: (askpass: AskpassEnvironment) => Promise<Result>
    ): Promise<Result> => {
      const user = host.sshOverrides?.user
      if (!user) throw new ComputeConnectionError('unsupported_auth_configuration')
      const askpass = await this.createAskpass(password, prepared.expectedAccounts)
      try {
        const result = await operation(askpass)
        if (askpass.wasUnsupportedPromptRejected?.() || !askpass.wasAnswered()) {
          throw new ComputeConnectionError('unsupported_auth_configuration')
        }
        return result
      } finally {
        await askpass.dispose()
      }
    }
    return {
      run: async (command, options) =>
        withAskpass(async (askpass) => {
          const result = await this.runner.run(target, command, {
            ...options,
            env: askpass.env,
            signal: request.signal ?? options.signal
          })
          const failure = classifyPasswordConnectionFailure(result, askpass)
          if (failure) throw failure
          return result
        }),
      upload: async (localPath, remotePath) =>
        withAskpass(async (askpass) => {
          if (!this.scpRunner) throw new ComputeConnectionError('unsupported_auth_configuration')
          const result = await this.scpRunner.copy(
            resolveScpBinary(),
            buildScpUploadArgs(target, localPath, remotePath),
            30 * 60 * 1000,
            { env: askpass.env, signal: request.signal }
          )
          const failure = classifyPasswordConnectionFailure(result, askpass)
          if (failure) throw failure
          if (result.exitCode !== 0) throw new Error('Remote file upload failed.')
        }),
      download: async (remotePath, localPath, maxBytes): Promise<BoundedScpResult> =>
        withAskpass(async (askpass) => {
          if (!this.scpRunner) throw new ComputeConnectionError('unsupported_auth_configuration')
          if (!this.scpRunner.copyFromRemoteBounded)
            throw new ComputeConnectionError('unsupported_auth_configuration')
          const result = await this.scpRunner.copyFromRemoteBounded(
            target,
            remotePath,
            localPath,
            maxBytes,
            10 * 60 * 1000,
            { env: askpass.env, signal: request.signal }
          )
          if (result.exceeded) return result
          const failure = classifyPasswordConnectionFailure(result, askpass)
          if (failure) throw failure
          return result
        })
    }
  }

  private async prepareTarget(
    host: ComputeHost,
    signal?: AbortSignal
  ): Promise<PreparedPasswordTarget> {
    const user = host.sshOverrides?.user
    const port = host.sshOverrides?.port
    if (!user || !port) throw new ComputeConnectionError('unsupported_auth_configuration')
    const effectiveConfig = await this.readConfig(host.sshAlias)
    const proxyJump = effectiveConfig['proxyjump']
    const proxyCommand = effectiveConfig['proxycommand']
    if (
      (proxyJump && proxyJump.toLowerCase() !== 'none') ||
      (proxyCommand && proxyCommand.toLowerCase() !== 'none')
    ) {
      throw new ComputeConnectionError('unsupported_auth_configuration')
    }
    const base = await this.resolveTarget(
      host.sshAlias,
      { user, port },
      async () => effectiveConfig
    )
    const inheritedArgs = withoutInheritedAuthenticationOptions(base.extraArgs)
    const policy = [
      '-o',
      'ProxyJump=none',
      '-o',
      'ProxyCommand=none',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityFile=/dev/null',
      '-o',
      'IdentityAgent=none',
      '-o',
      'ForwardAgent=no',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no'
    ]
    const preflight = await this.runner.run(
      {
        ...base,
        extraArgs: [
          ...inheritedArgs,
          ...policy,
          '-o',
          'BatchMode=yes',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'PreferredAuthentications=none'
        ]
      },
      'exit 0',
      { timeoutMs: 15_000, loginShell: false, maxOutputBytes: 4 * 1024, signal }
    )
    const failure = classifyConnectionFailure(preflight)
    if (
      failure?.code === 'host_key_unknown' ||
      failure?.code === 'host_key_changed' ||
      failure?.code === 'host_unreachable' ||
      failure?.code === 'timeout'
    )
      throw failure
    const target = { ...base, extraArgs: [...inheritedArgs, ...policy] }
    const accountHosts = new Set([target.host, host.sshAlias])
    const effectiveHostname = effectiveConfig['hostname']?.trim()
    if (effectiveHostname && effectiveHostname.toLowerCase() !== 'none') {
      accountHosts.add(effectiveHostname)
    }
    return {
      target,
      expectedAccounts: [...accountHosts].map((accountHost) => `${user}@${accountHost}`)
    }
  }
}

export { PasswordSshAdapter, createAskpassEnvironment }
