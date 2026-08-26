import { execFile } from 'node:child_process'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { RemoteItInstallation, RemoteItService } from '../../shared/remote-access'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 400_000
const REMOTE_IT_HTTP_TYPE = 7
const REMOTE_IT_BATCH_MARKER = '__OPEN_SCIENCE_REMOTEIT_BATCH_COMMAND_END__'
const REMOTE_IT_STATUS_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000, 5_000] as const
const REMOTE_IT_DEVICE_SETUP_AUTHORIZATION_MESSAGE =
  'This computer must be added as a Remote.It Device before Open Science can configure remote access. In Remote.It, choose +, select This system, and complete Add Device once. Then return to Open Science and click Detect again; both Open Science services will be created automatically.'
export const REMOTE_IT_APP_SERVICE_NAME = 'Open Science Remote'
export const REMOTE_IT_BROWSER_SERVICE_NAME = 'System Service'

type CommandResult = { stdout: string; stderr: string }
export type RemoteItCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<CommandResult>

type RemoteItStatusEntry = {
  addressHost?: unknown
  addressPort?: unknown
  id?: unknown
  isEnabled?: unknown
  name?: unknown
  state?: unknown
  type?: unknown
}

type RemoteItStatusData = {
  owner?: unknown
  device?: RemoteItStatusEntry
  services?: RemoteItStatusEntry[]
}

type RemoteItConnectLink = {
  enabled?: unknown
  service?: { id?: unknown }
  url?: unknown
}

const defaultCommandRunner: RemoteItCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    encoding: 'utf8'
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

const friendlyRemoteItError = (detail: string): string => {
  if (/"code"\s*:\s*101\b/.test(detail) || /agent not reachable/i.test(detail)) {
    return 'Remote.It is still switching its background service mode. Wait a few seconds, then click Detect again. Do not add the device again.'
  }
  if (
    /command failed:.*remoteit status --json/is.test(detail) ||
    /config\s*-\s*file does not exist/i.test(detail)
  ) {
    return 'Remote.It has not finished switching its background service mode. Wait a few seconds, then click Detect again. Do not add the device again.'
  }
  if (
    /"code"\s*:\s*12\b/.test(detail) ||
    /must be signed in to perform this operation/i.test(detail)
  ) {
    return REMOTE_IT_DEVICE_SETUP_AUTHORIZATION_MESSAGE
  }
  return detail
}

const commandError = (error: unknown, fallback: string): Error => {
  if (!error || typeof error !== 'object') return new Error(fallback)
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  const detail = [value.stderr, value.stdout, value.message]
    .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    ?.trim()
  return new Error(detail ? friendlyRemoteItError(detail) : fallback)
}

const errorText = (error: unknown): string => {
  if (!error || typeof error !== 'object') return String(error ?? '')
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  return [value.stderr, value.stdout, value.message]
    .filter((entry): entry is string => typeof entry === 'string')
    .join('\n')
}

const requiresElevation = (error: unknown): boolean => {
  const detail = errorText(error)
  return (
    /"code"\s*:\s*7003/.test(detail) ||
    /must run this command with elevated privileges/i.test(detail)
  )
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

const buildMacElevationScript = (binaryPath: string, args: string[]): string => {
  const command = [binaryPath, ...args].map(shellQuote).join(' ')
  return `do shell script ${JSON.stringify(command)} with administrator privileges`
}

const buildMacElevationBatchScript = (binaryPath: string, commands: string[][]): string => {
  const command = commands
    .map(
      (args) =>
        `${[binaryPath, ...args].map(shellQuote).join(' ')} && printf '\\n%s\\n' ${shellQuote(REMOTE_IT_BATCH_MARKER)}`
    )
    .join(' && ')
  return `do shell script ${JSON.stringify(command)} with administrator privileges`
}

const assertMutationSucceeded = (result: CommandResult): CommandResult => {
  const output = result.stdout.trim() || result.stderr.trim()
  // Remote.It normally returns JSON for every mutation made with --json. Some releases have
  // returned a JSON error with exit code 0, so checking only execFile's rejection is not enough.
  if (output.includes('{')) parseRemoteItJson(output)
  return result
}

const mutationArgsForPlatform = (args: string[], platform: NodeJS.Platform): string[] =>
  platform === 'win32' && !args.includes('--noAdmin') ? [...args, '--noAdmin'] : args

const runRemoteItMutation = async (
  binaryPath: string,
  args: string[],
  run: RemoteItCommandRunner,
  platform: NodeJS.Platform,
  timeoutMs = 30_000
): Promise<CommandResult> => {
  const platformArgs = mutationArgsForPlatform(args, platform)
  try {
    return assertMutationSucceeded(await run(binaryPath, platformArgs, { timeoutMs }))
  } catch (error) {
    if (!requiresElevation(error) || platform !== 'darwin') throw error
    try {
      return assertMutationSucceeded(
        await run('/usr/bin/osascript', ['-e', buildMacElevationScript(binaryPath, args)], {
          timeoutMs: 120_000
        })
      )
    } catch (elevatedError) {
      const detail = commandError(
        elevatedError,
        'Administrator approval was cancelled or Remote.It could not complete the command.'
      ).message
      throw new Error(`Remote.It administrator approval failed: ${detail}`)
    }
  }
}

const splitBatchOutput = (stdout: string, expected: number): string[] => {
  const parts = stdout
    .replace(/\r/g, '\n')
    .split(REMOTE_IT_BATCH_MARKER)
    .slice(0, expected)
    .map((part) => part.trim())
  if (parts.length !== expected || parts.some((part) => !part)) {
    throw new Error('Remote.It returned incomplete results while preparing remote access.')
  }
  return parts
}

const runRemoteItMutationBatch = async (
  binaryPath: string,
  commands: string[][],
  run: RemoteItCommandRunner,
  platform: NodeJS.Platform,
  timeoutMs = 30_000
): Promise<CommandResult[]> => {
  const runElevated = async (elevatedCommands: string[][]): Promise<CommandResult[]> => {
    try {
      const elevated = await run(
        '/usr/bin/osascript',
        ['-e', buildMacElevationBatchScript(binaryPath, elevatedCommands)],
        { timeoutMs: 120_000 }
      )
      const outputs = splitBatchOutput(elevated.stdout, elevatedCommands.length)
      return outputs.map((stdout) => assertMutationSucceeded({ stdout, stderr: elevated.stderr }))
    } catch (elevatedError) {
      const detail = commandError(
        elevatedError,
        'Administrator approval was cancelled or Remote.It could not complete the commands.'
      ).message
      throw new Error(`Remote.It administrator approval failed: ${detail}`)
    }
  }

  const results: CommandResult[] = []
  for (let index = 0; index < commands.length; index += 1) {
    const args = commands[index]
    try {
      results.push(
        assertMutationSucceeded(
          await run(binaryPath, mutationArgsForPlatform(args, platform), { timeoutMs })
        )
      )
    } catch (error) {
      if (!requiresElevation(error) || platform !== 'darwin') throw error
      const remaining = commands.slice(index)
      results.push(...(await runElevated(remaining)))
      return results
    }
  }
  return results
}

export const parseRemoteItJson = (text: string): Record<string, unknown> => {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Remote.It returned invalid status data.')
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
  if (typeof parsed.code === 'number' && parsed.code !== 0) {
    const message =
      typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : 'Remote.It reported an error.'
    throw new Error(message)
  }
  return parsed
}

const parseRemoteItGraphQlData = (text: string): Record<string, unknown> => {
  const result = parseRemoteItJson(text)
  const payload =
    typeof result.data === 'string'
      ? (JSON.parse(result.data) as Record<string, unknown>)
      : (result.data as Record<string, unknown> | undefined)
  if (!payload || typeof payload !== 'object') {
    throw new Error('Remote.It returned invalid cloud configuration data.')
  }
  const errors = Array.isArray(payload.errors) ? payload.errors : []
  if (errors.length > 0) {
    const detail = errors
      .map((entry) =>
        entry && typeof entry === 'object' && typeof entry.message === 'string'
          ? entry.message.trim()
          : ''
      )
      .filter(Boolean)
      .join(' ')
    throw new Error(detail || 'Remote.It rejected the cloud configuration request.')
  }
  const data = payload.data
  if (!data || typeof data !== 'object') {
    throw new Error('Remote.It did not return cloud configuration data.')
  }
  return data as Record<string, unknown>
}

const statusData = (status: Record<string, unknown>): RemoteItStatusData =>
  (status.data ?? status) as RemoteItStatusData

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const isLoopbackHost = (value: unknown): boolean => {
  const host = stringValue(value)?.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

const serviceView = (entry: RemoteItStatusEntry): RemoteItService | undefined => {
  const id = stringValue(entry.id)
  const host = stringValue(entry.addressHost)
  const port = numberValue(entry.addressPort)
  if (!id || !host || port === undefined) return undefined
  return {
    id,
    host,
    port,
    enabled: entry.isEnabled === true,
    ready: entry.isEnabled === true && entry.state === 4
  }
}

const executable = async (path: string): Promise<boolean> => {
  if (!existsSync(path)) return false
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

const knownBinaryPaths = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => {
  const configured = env.OPEN_SCIENCE_REMOTEIT_BIN?.trim()
  const paths = configured ? [configured] : []
  if (platform === 'darwin') {
    paths.push(
      '/Applications/Remote.It.app/Contents/Resources/remoteit',
      '/usr/local/bin/remoteit',
      '/opt/homebrew/bin/remoteit'
    )
  } else if (platform === 'win32') {
    const programFiles = env.ProgramFiles?.trim()
    const programFilesX86 = env['ProgramFiles(x86)']?.trim()
    if (programFiles) {
      paths.push(
        `${programFiles}\\Remote.It\\resources\\remoteit.exe`,
        `${programFiles}\\remoteit\\resources\\remoteit.exe`,
        `${programFiles}\\Remote.It\\remoteit.exe`,
        `${programFiles}\\remoteit\\remoteit.exe`
      )
    }
    if (programFilesX86) {
      paths.push(
        `${programFilesX86}\\Remote.It\\resources\\remoteit.exe`,
        `${programFilesX86}\\remoteit\\resources\\remoteit.exe`,
        `${programFilesX86}\\Remote.It\\remoteit.exe`,
        `${programFilesX86}\\remoteit\\remoteit.exe`
      )
    }
  } else {
    paths.push('/usr/bin/remoteit', '/usr/local/bin/remoteit')
  }
  return paths
}

const locateFromPath = async (
  platform: NodeJS.Platform,
  run: RemoteItCommandRunner
): Promise<string | undefined> => {
  try {
    const locator = platform === 'win32' ? 'where.exe' : 'which'
    const result = await run(locator, [platform === 'win32' ? 'remoteit.exe' : 'remoteit'], {
      timeoutMs: 3_000
    })
    return result.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

export const findRemoteItBinary = async (
  run: RemoteItCommandRunner = defaultCommandRunner,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> => {
  const fromPath = await locateFromPath(platform, run)
  const candidates = [...(fromPath ? [fromPath] : []), ...knownBinaryPaths(platform, env)]
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

const readVersion = async (
  binaryPath: string,
  run: RemoteItCommandRunner
): Promise<string | undefined> => {
  try {
    const { stdout } = await run(binaryPath, ['version'], { timeoutMs: 5_000 })
    return stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

const readStatus = async (
  binaryPath: string,
  run: RemoteItCommandRunner
): Promise<Record<string, unknown>> => {
  const { stdout } = await run(binaryPath, ['status', '--json'], { timeoutMs: 7_000 })
  return parseRemoteItJson(stdout)
}

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })

const readStatusAfterMutation = async (
  binaryPath: string,
  run: RemoteItCommandRunner,
  isReady: (status: Record<string, unknown>) => boolean = () => true
): Promise<Record<string, unknown>> => {
  let lastError: unknown
  for (let attempt = 0; ; attempt += 1) {
    try {
      const status = await readStatus(binaryPath, run)
      if (isReady(status)) return status
      lastError = new Error('Remote.It status has not reported all accepted service changes yet.')
    } catch (error) {
      lastError = error
    }
    if (attempt >= REMOTE_IT_STATUS_RETRY_DELAYS_MS.length) break
    await wait(REMOTE_IT_STATUS_RETRY_DELAYS_MS[attempt])
  }
  const detail = commandError(lastError, 'Remote.It status is temporarily unavailable.').message
  throw new Error(
    `Remote.It accepted the service changes, but its background agent is still restarting. Open Science saved the new Service IDs and will reuse them. Wait a few seconds, then click Detect; do not add the device or switch modes again. Technical details: ${detail}`
  )
}

const installationView = (
  binaryPath: string,
  version: string | undefined,
  status: Record<string, unknown>,
  preferredServiceId?: string
): RemoteItInstallation => {
  const data = statusData(status)
  const account = stringValue(data.owner)
  const deviceId = stringValue(data.device?.id)
  const serviceEntry = preferredServiceId
    ? data.services?.find((entry) => stringValue(entry.id) === preferredServiceId)
    : undefined
  return {
    installed: true,
    // Remote.It does not expose the signed-in desktop account through `status --json` until this
    // computer has been registered as a Device. A registered Device is therefore also sufficient
    // evidence that the CLI is associated with an account.
    loggedIn: Boolean(account || deviceId),
    registered: Boolean(deviceId),
    binaryPath,
    version,
    account,
    deviceId,
    service: serviceEntry ? serviceView(serviceEntry) : undefined
  }
}

export const detectRemoteIt = async (
  preferredServiceId?: string,
  run: RemoteItCommandRunner = defaultCommandRunner,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoteItInstallation> => {
  const binaryPath = await findRemoteItBinary(run, platform, env)
  if (!binaryPath) return { installed: false, loggedIn: false, registered: false }

  const version = await readVersion(binaryPath, run)
  try {
    return installationView(
      binaryPath,
      version,
      await readStatus(binaryPath, run),
      preferredServiceId
    )
  } catch (error) {
    return {
      installed: true,
      loggedIn: false,
      registered: false,
      binaryPath,
      version,
      error: commandError(error, 'Unable to read Remote.It status.').message
    }
  }
}

const serviceEntries = (status: Record<string, unknown>): RemoteItStatusEntry[] =>
  statusData(status).services?.filter((entry) => numberValue(entry.type) !== 35) ?? []

const hasManagedEndpoint = (entry: RemoteItStatusEntry, localPort: number): boolean =>
  numberValue(entry.type) === REMOTE_IT_HTTP_TYPE &&
  isLoopbackHost(entry.addressHost) &&
  numberValue(entry.addressPort) === localPort

const matchingManagedService = (
  status: Record<string, unknown>,
  serviceId: string | undefined,
  localPort: number,
  serviceName?: string
): RemoteItStatusEntry | undefined => {
  const services = serviceEntries(status)
  const stored = serviceId
    ? services.find((entry) => stringValue(entry.id) === serviceId)
    : undefined
  if (stored) return stored

  if (serviceName) {
    const named = services.filter(
      (entry) =>
        stringValue(entry.name) === serviceName &&
        numberValue(entry.type) === REMOTE_IT_HTTP_TYPE &&
        isLoopbackHost(entry.addressHost) &&
        numberValue(entry.addressPort) === localPort
    )
    return named.length === 1 ? named[0] : undefined
  }

  const exact = services.filter(
    (entry) =>
      numberValue(entry.type) === REMOTE_IT_HTTP_TYPE &&
      isLoopbackHost(entry.addressHost) &&
      numberValue(entry.addressPort) === localPort
  )
  return exact.length === 1 ? exact[0] : undefined
}

const shouldReadCloudServiceNames = (
  status: Record<string, unknown>,
  localPort: number,
  managedServiceIds: ReadonlySet<string>
): boolean =>
  serviceEntries(status).some((entry) => {
    const id = stringValue(entry.id)
    return (
      hasManagedEndpoint(entry, localPort) &&
      !stringValue(entry.name) &&
      Boolean(id && !managedServiceIds.has(id))
    )
  })

const readCloudServiceNames = async (
  binaryPath: string,
  deviceId: string,
  run: RemoteItCommandRunner
): Promise<Map<string, string>> => {
  const query = `query OpenScienceDeviceServices {
  login {
    devices(size: 1, id: ${JSON.stringify(deviceId)}) {
      items {
        id
        services { id name }
      }
    }
  }
}`
  const { stdout } = await run(binaryPath, ['exec-gql', '--noAdmin', '--json', '--query', query], {
    timeoutMs: 30_000
  })
  const data = parseRemoteItGraphQlData(stdout)
  const login = data.login as
    | {
        devices?: {
          items?: Array<{
            id?: unknown
            services?: Array<{ id?: unknown; name?: unknown }>
          }>
        }
      }
    | undefined
  const device = login?.devices?.items?.find((entry) => stringValue(entry.id) === deviceId)
  const names = new Map<string, string>()
  for (const service of device?.services ?? []) {
    const id = stringValue(service.id)
    const name = stringValue(service.name)
    if (id && name) names.set(id, name)
  }
  return names
}

const enrichWindowsServiceNames = async (
  binaryPath: string,
  status: Record<string, unknown>,
  localPort: number,
  managedServiceIds: ReadonlySet<string>,
  run: RemoteItCommandRunner,
  platform: NodeJS.Platform
): Promise<Record<string, unknown>> => {
  if (platform !== 'win32' || !shouldReadCloudServiceNames(status, localPort, managedServiceIds)) {
    return status
  }
  const deviceId = stringValue(statusData(status).device?.id)
  if (!deviceId) return status

  try {
    const names = await readCloudServiceNames(binaryPath, deviceId, run)
    const unresolvedIds: string[] = []
    for (const entry of serviceEntries(status)) {
      const id = stringValue(entry.id)
      if (!id || !hasManagedEndpoint(entry, localPort) || managedServiceIds.has(id)) continue
      const name = names.get(id)
      if (name) entry.name = name
      else unresolvedIds.push(id)
    }
    if (unresolvedIds.length > 0) {
      throw new Error(
        'Remote.It has not reported the names of existing Windows services yet. Wait a few seconds, then try again; Open Science did not create duplicates.'
      )
    }
    return status
  } catch (error) {
    throw commandError(
      error,
      'Remote.It could not identify existing Windows services, so Open Science stopped before creating duplicates.'
    )
  }
}

const assertDeviceRegistered = (status: Record<string, unknown>): void => {
  if (!stringValue(statusData(status).device?.id)) {
    throw new Error(REMOTE_IT_DEVICE_SETUP_AUTHORIZATION_MESSAGE)
  }
}

const requireRegisteredDevice = (status: Record<string, unknown>): Record<string, unknown> => {
  assertDeviceRegistered(status)
  return status
}

const modifyService = async (
  binaryPath: string,
  serviceId: string,
  localPort: number,
  enabled: boolean,
  run: RemoteItCommandRunner,
  platform: NodeJS.Platform
): Promise<void> => {
  try {
    await runRemoteItMutation(
      binaryPath,
      [
        'service',
        'modify',
        '--id',
        serviceId,
        '--port',
        String(localPort),
        '--hostname',
        '127.0.0.1',
        '--type',
        'HTTP',
        '--enable',
        String(enabled),
        '--json'
      ],
      run,
      platform
    )
  } catch (error) {
    throw commandError(
      error,
      'Remote.It could not update the Open Science service. On macOS or Linux, service management may require administrator approval.'
    )
  }
}

const hasExpectedServiceConfiguration = (
  service: RemoteItStatusEntry,
  localPort: number,
  enabled: boolean
): boolean =>
  numberValue(service.type) === REMOTE_IT_HTTP_TYPE &&
  isLoopbackHost(service.addressHost) &&
  numberValue(service.addressPort) === localPort &&
  service.isEnabled === enabled

const hasReadyServiceConfiguration = (service: RemoteItStatusEntry, localPort: number): boolean =>
  hasExpectedServiceConfiguration(service, localPort, true) && service.state === 4

const serviceById = (
  status: Record<string, unknown>,
  serviceId: string
): RemoteItStatusEntry | undefined =>
  serviceEntries(status).find((entry) => stringValue(entry.id) === serviceId)

type ManagedRemoteItServices = {
  active: 'app' | 'browser'
  appServiceId?: string
  browserServiceId?: string
  onServiceIdsDiscovered?: (services: {
    appServiceId?: string
    browserServiceId?: string
  }) => Promise<void>
}

type PlannedRemoteItMutation = {
  args: string[]
  kind: 'add' | 'modify'
  target?: 'app' | 'browser'
}

const findStringByKey = (value: unknown, keys: ReadonlySet<string>): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const result = stringValue(entry)
      if (result) return result
    }
  }
  for (const entry of Object.values(value)) {
    const result = findStringByKey(entry, keys)
    if (result) return result
  }
  return undefined
}

const serviceIdFromMutation = (result: CommandResult): string | undefined => {
  try {
    const parsed = parseRemoteItJson(result.stdout.trim() || result.stderr.trim())
    return findStringByKey(parsed, new Set(['serviceid', 'service_id', 'id']))
  } catch {
    return undefined
  }
}

const managedServiceArgs = (name: string, localPort: number, serviceId?: string): string[] =>
  serviceId
    ? [
        'service',
        'modify',
        '--id',
        serviceId,
        '--port',
        String(localPort),
        '--hostname',
        '127.0.0.1',
        '--type',
        'HTTP',
        '--enable',
        'true',
        '--json'
      ]
    : [
        'service',
        'add',
        '--name',
        name,
        '--port',
        String(localPort),
        '--hostname',
        '127.0.0.1',
        '--type',
        'HTTP',
        '--enable',
        'true',
        '--json'
      ]

export const enableRemoteItServices = async (
  binaryPath: string,
  localPort: number,
  managed: ManagedRemoteItServices,
  run: RemoteItCommandRunner = defaultCommandRunner,
  platform: NodeJS.Platform = process.platform
): Promise<{
  installation: RemoteItInstallation
  appServiceId: string
  browserServiceId: string
}> => {
  let status = await readStatus(binaryPath, run)
  assertDeviceRegistered(status)
  status = await enrichWindowsServiceNames(
    binaryPath,
    status,
    localPort,
    new Set(
      [managed.appServiceId, managed.browserServiceId].filter(
        (id): id is string => id !== undefined
      )
    ),
    run,
    platform
  )

  const beforeIds = new Set(
    serviceEntries(status).flatMap((entry) => {
      const id = stringValue(entry.id)
      return id ? [id] : []
    })
  )
  const existing = {
    app: matchingManagedService(
      status,
      managed.appServiceId,
      localPort,
      REMOTE_IT_APP_SERVICE_NAME
    ),
    browser: matchingManagedService(
      status,
      managed.browserServiceId,
      localPort,
      REMOTE_IT_BROWSER_SERVICE_NAME
    )
  }
  const planned: PlannedRemoteItMutation[] = []

  for (const target of ['app', 'browser'] as const) {
    const service = existing[target]
    const serviceId = stringValue(service?.id)
    if (service && hasExpectedServiceConfiguration(service, localPort, true)) continue
    planned.push({
      kind: serviceId ? 'modify' : 'add',
      target,
      args: managedServiceArgs(
        target === 'app' ? REMOTE_IT_APP_SERVICE_NAME : REMOTE_IT_BROWSER_SERVICE_NAME,
        localPort,
        serviceId
      )
    })
  }

  let results: CommandResult[] = []
  try {
    results =
      planned.length > 0
        ? await runRemoteItMutationBatch(
            binaryPath,
            planned.map((operation) => operation.args),
            run,
            platform,
            30_000
          )
        : []
  } catch (error) {
    throw commandError(
      error,
      'Remote.It could not prepare the App and Browser services. On macOS or Linux, initial service management may require administrator approval.'
    )
  }

  const addedTargets = planned.filter(
    (operation): operation is PlannedRemoteItMutation & { target: 'app' | 'browser' } =>
      operation.kind === 'add' && operation.target !== undefined
  )
  const addedIds = new Map<'app' | 'browser', string>()
  for (let index = 0; index < planned.length; index += 1) {
    const operation = planned[index]
    if (operation.kind !== 'add' || !operation.target) continue
    const serviceId = serviceIdFromMutation(results[index])
    if (serviceId) addedIds.set(operation.target, serviceId)
  }
  if (addedIds.size > 0) {
    await managed.onServiceIdsDiscovered?.({
      appServiceId: stringValue(existing.app?.id) ?? addedIds.get('app') ?? managed.appServiceId,
      browserServiceId:
        stringValue(existing.browser?.id) ?? addedIds.get('browser') ?? managed.browserServiceId
    })
  }

  const statusIncludesPlannedMutations = (candidate: Record<string, unknown>): boolean => {
    const entries = serviceEntries(candidate)
    const knownAddedIds = new Set(addedIds.values())
    let unresolvedAddCount = 0

    for (const operation of planned) {
      if (!operation.target) continue
      const expectedId =
        operation.kind === 'modify'
          ? stringValue(existing[operation.target]?.id)
          : addedIds.get(operation.target)
      if (!expectedId) {
        unresolvedAddCount += 1
        continue
      }
      const entry = entries.find((candidateEntry) => stringValue(candidateEntry.id) === expectedId)
      if (!entry || !hasExpectedServiceConfiguration(entry, localPort, true)) return false
    }

    const unresolvedNewEntries = entries.filter((entry) => {
      const id = stringValue(entry.id)
      return (
        Boolean(id && !beforeIds.has(id) && !knownAddedIds.has(id)) &&
        hasExpectedServiceConfiguration(entry, localPort, true)
      )
    })
    return unresolvedNewEntries.length >= unresolvedAddCount
  }

  status =
    planned.length > 0
      ? await readStatusAfterMutation(binaryPath, run, statusIncludesPlannedMutations)
      : status
  const finalEntries = serviceEntries(status)
  const newEntries = finalEntries.filter((entry) => {
    const id = stringValue(entry.id)
    return Boolean(id && !beforeIds.has(id))
  })
  const namedAppServiceId = stringValue(
    finalEntries.find((entry) => stringValue(entry.name) === REMOTE_IT_APP_SERVICE_NAME)?.id
  )
  const namedBrowserServiceId = stringValue(
    finalEntries.find((entry) => stringValue(entry.name) === REMOTE_IT_BROWSER_SERVICE_NAME)?.id
  )
  if (namedAppServiceId && !addedIds.has('app')) addedIds.set('app', namedAppServiceId)
  if (namedBrowserServiceId && !addedIds.has('browser')) {
    addedIds.set('browser', namedBrowserServiceId)
  }
  const unresolvedTargets = addedTargets
    .map((operation) => operation.target)
    .filter((target) => !addedIds.has(target))
  const unusedNewIds = newEntries
    .map((entry) => stringValue(entry.id))
    .filter((id): id is string => Boolean(id && ![...addedIds.values()].includes(id)))
  if (unresolvedTargets.length === unusedNewIds.length) {
    unresolvedTargets.forEach((target, index) => addedIds.set(target, unusedNewIds[index]))
  }

  const appServiceId =
    stringValue(existing.app?.id) ??
    addedIds.get('app') ??
    namedAppServiceId ??
    managed.appServiceId
  const browserServiceId =
    stringValue(existing.browser?.id) ??
    addedIds.get('browser') ??
    namedBrowserServiceId ??
    managed.browserServiceId
  if (!appServiceId || !browserServiceId || appServiceId === browserServiceId) {
    throw new Error('Remote.It did not return two distinct Open Science service identifiers.')
  }
  await managed.onServiceIdsDiscovered?.({ appServiceId, browserServiceId })

  const reportsReadyManagedServices = (candidate: Record<string, unknown>): boolean => {
    const app = serviceById(candidate, appServiceId)
    const browser = serviceById(candidate, browserServiceId)
    return Boolean(
      app &&
      hasReadyServiceConfiguration(app, localPort) &&
      browser &&
      hasReadyServiceConfiguration(browser, localPort)
    )
  }
  if (!reportsReadyManagedServices(status)) {
    status = await readStatusAfterMutation(binaryPath, run, reportsReadyManagedServices)
  }

  const finalApp = serviceById(status, appServiceId)
  const finalBrowser = serviceById(status, browserServiceId)
  if (
    !finalApp ||
    !hasReadyServiceConfiguration(finalApp, localPort) ||
    !finalBrowser ||
    !hasReadyServiceConfiguration(finalBrowser, localPort)
  ) {
    throw new Error(
      `Remote.It did not make both Open Science service endpoints ready at 127.0.0.1:${localPort}.`
    )
  }

  const activeServiceId = managed.active === 'app' ? appServiceId : browserServiceId
  return {
    installation: installationView(
      binaryPath,
      await readVersion(binaryPath, run),
      status,
      activeServiceId
    ),
    appServiceId,
    browserServiceId
  }
}

export const enableRemoteItService = async (
  binaryPath: string,
  localPort: number,
  managedService: { name: string; preferredServiceId?: string },
  run: RemoteItCommandRunner = defaultCommandRunner,
  platform: NodeJS.Platform = process.platform
): Promise<{ installation: RemoteItInstallation; serviceId: string }> => {
  let status = requireRegisteredDevice(await readStatus(binaryPath, run))
  let service = matchingManagedService(
    status,
    managedService.preferredServiceId,
    localPort,
    managedService.name
  )

  if (service) {
    const serviceId = stringValue(service.id)
    if (!serviceId) throw new Error('Remote.It returned an invalid service identifier.')
    const needsRepair = !hasExpectedServiceConfiguration(service, localPort, true)
    if (needsRepair) {
      await modifyService(binaryPath, serviceId, localPort, true, run, platform)
    }
  } else {
    const beforeIds = new Set(
      serviceEntries(status).flatMap((entry) => {
        const id = stringValue(entry.id)
        return id ? [id] : []
      })
    )
    try {
      await runRemoteItMutation(
        binaryPath,
        [
          'service',
          'add',
          '--name',
          managedService.name,
          '--port',
          String(localPort),
          '--hostname',
          '127.0.0.1',
          '--type',
          'HTTP',
          '--enable',
          'true',
          '--json'
        ],
        run,
        platform
      )
    } catch (error) {
      throw commandError(
        error,
        'Remote.It could not create the Open Science service. On macOS or Linux, service management may require administrator approval.'
      )
    }
    status = await readStatus(binaryPath, run)
    const added = serviceEntries(status).filter(
      (entry) =>
        !beforeIds.has(stringValue(entry.id) ?? '') &&
        numberValue(entry.type) === REMOTE_IT_HTTP_TYPE &&
        isLoopbackHost(entry.addressHost) &&
        numberValue(entry.addressPort) === localPort
    )
    service =
      added.length === 1
        ? added[0]
        : matchingManagedService(status, undefined, localPort, managedService.name)
  }

  status = await readStatus(binaryPath, run)
  const expectedServiceId = stringValue(service?.id) ?? managedService.preferredServiceId
  const finalService = expectedServiceId
    ? serviceById(status, expectedServiceId)
    : matchingManagedService(status, undefined, localPort, managedService.name)
  const serviceId = stringValue(finalService?.id)
  if (!serviceId) {
    throw new Error('Remote.It created the service but did not report its identifier.')
  }
  if (!finalService || !hasExpectedServiceConfiguration(finalService, localPort, true)) {
    throw new Error(
      `Remote.It did not apply the Open Science service endpoint 127.0.0.1:${localPort}.`
    )
  }
  const installation = installationView(
    binaryPath,
    await readVersion(binaryPath, run),
    status,
    serviceId
  )
  if (!installation.service?.enabled) {
    throw new Error('Remote.It created the Open Science service but it is not enabled.')
  }
  return { installation, serviceId }
}

export const ensureRemoteItConnectLink = async (
  binaryPath: string,
  serviceId: string,
  run: RemoteItCommandRunner = defaultCommandRunner
): Promise<string> => {
  // setConnectLink(enabled: true) is idempotent while the link remains enabled: Remote.It returns
  // the existing Persistent Public URL instead of rotating it. This makes Detect safe to run
  // repeatedly and also repairs a link that the user disabled in Remote.It.
  const query = `mutation OpenScienceEnableConnectLink {
  setConnectLink(serviceId: ${JSON.stringify(serviceId)}, enabled: true) {
    enabled
    url
    service { id }
  }
}`
  try {
    const { stdout } = await run(
      binaryPath,
      ['exec-gql', '--noAdmin', '--json', '--query', query],
      { timeoutMs: 30_000 }
    )
    const data = parseRemoteItGraphQlData(stdout)
    const link = data.setConnectLink as RemoteItConnectLink | undefined
    const returnedServiceId = stringValue(link?.service?.id)
    const url = stringValue(link?.url)
    if (link?.enabled !== true || returnedServiceId !== serviceId || !url) {
      throw new Error('Remote.It did not enable a Persistent Public URL for Open Science.')
    }
    return url
  } catch (error) {
    const detail = commandError(
      error,
      'Remote.It could not enable the Persistent Public URL for Open Science.'
    ).message
    throw new Error(`Remote.It browser URL setup failed: ${detail}`)
  }
}

export const disableRemoteItConnectLink = async (
  binaryPath: string,
  serviceId: string,
  run: RemoteItCommandRunner = defaultCommandRunner
): Promise<void> => {
  const query = `mutation OpenScienceDisableConnectLink {
  setConnectLink(serviceId: ${JSON.stringify(serviceId)}, enabled: false) {
    enabled
    service { id }
  }
}`
  try {
    const { stdout } = await run(
      binaryPath,
      ['exec-gql', '--noAdmin', '--json', '--query', query],
      { timeoutMs: 30_000 }
    )
    const data = parseRemoteItGraphQlData(stdout)
    const link = data.setConnectLink as RemoteItConnectLink | undefined
    if (link?.enabled !== false || stringValue(link?.service?.id) !== serviceId) {
      throw new Error('Remote.It did not disable the service public endpoint.')
    }
  } catch (error) {
    const detail = commandError(
      error,
      'Remote.It could not disable the service public endpoint.'
    ).message
    throw new Error(`Remote.It public endpoint privacy setup failed: ${detail}`)
  }
}

export {
  buildMacElevationBatchScript,
  buildMacElevationScript,
  isLoopbackHost,
  knownBinaryPaths,
  matchingManagedService,
  mutationArgsForPlatform,
  parseRemoteItGraphQlData,
  requiresElevation,
  runRemoteItMutationBatch,
  runRemoteItMutation,
  serviceView
}
