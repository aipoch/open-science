/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url))

export const openBrowser = (url) => {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8_000, windowsHide: true }, (error) => resolve(!error))
  })
}

export const providerTerminalAction = (profile, draft, providerId, { protocol, endpoint }) => {
  const argv = [
    cliPath,
    'provider',
    'setup',
    providerId,
    '--protocol',
    protocol,
    // The draft has no secrets. Encoding avoids shell interpretation of model names and URLs.
    '--draft',
    Buffer.from(JSON.stringify({ ...draft, expectedEndpoint: endpoint }), 'utf8').toString(
      'base64url'
    ),
    '--profile',
    profile
  ]
  const windows = process.platform === 'win32'
  const quote = (arg) =>
    `'${windows ? arg.replace(/['\u2018\u2019]/g, '$&$&') : arg.replaceAll("'", "'\\''")}'`
  return {
    action: 'enter_provider_credential',
    owner: 'user',
    executable: process.execPath,
    argv,
    shell: windows ? 'powershell' : 'posix',
    command: `${windows ? '& ' : ''}${[process.execPath, ...argv].map(quote).join(' ')}`,
    target: { profile, ...draft, providerId, protocol, endpoint },
    verify: { action: 'list_providers', arguments: { framework: draft.framework } }
  }
}

export const setupAction = ({ code, argv }, profile, framework, keylessKiloAvailable) => {
  const runtime = code.startsWith('runtime_')
  const prepare = runtime && framework
  const login =
    framework === 'codex' && argv?.[0] === 'codex' && argv[1] === 'login' && argv[2] === '--force'
  const choose = !runtime && code === 'provider_missing' && !login
  const action = prepare
    ? 'prepare_runtime'
    : login
      ? 'provider_login'
      : choose
        ? 'choose_provider'
        : runtime
          ? 'list_runtimes'
          : 'list_providers'
  return {
    code,
    action,
    owner: login || choose ? 'user' : 'agent',
    requiresUser: Boolean(login || choose),
    retryable: false,
    message: prepare
      ? 'Prepare this selected Agent runtime through Open-Science.'
      : login
        ? 'Report Codex sign-in in Open-Science Settings > Model. For an authorized sign-in, use the installed command or the same-profile Web handoff if needed. The user completes consent.'
        : choose
          ? 'List the available providers and ask the user which provider and model to use.'
          : runtime
            ? 'List the available runtimes and report what needs setup. The manual location is Settings > Agent.'
            : 'Use list_providers to inspect the selected provider and model. The manual location is Settings > Model.',
    ...(prepare ? { arguments: { framework } } : {}),
    ...(!runtime && !login ? { discovery: { capability: 'list_providers' } } : {}),
    ...(choose && framework && keylessKiloAvailable
      ? {
          options: [
            {
              label: 'Kilo Gateway (free, no API key)',
              capability: 'configure_provider',
              arguments: { provider: 'kilo-free', framework }
            }
          ]
        }
      : {}),
    ...(login
      ? {
          executable: process.execPath,
          argv: [cliPath, 'codex', 'login', '--force', ...(profile ? ['--profile', profile] : [])],
          web: { capability: 'open_setup' }
        }
      : {}),
    verify: { capability: 'get_setup_status', ...(profile ? { profile } : {}) }
  }
}

export const projectSubmissionReceipt = (receipt, profile) => {
  if (receipt.status === 'pending') {
    return {
      ...receipt,
      next: [{ action: 'wait_submission', requestId: receipt.requestId }]
    }
  }
  if (receipt.status !== 'failed' || receipt.error?.code !== 'provider_auth_required')
    return receipt
  const { code } = receipt.error
  return {
    ...receipt,
    error: {
      code,
      message:
        'The model provider requires authentication. Inspect the selected provider and ask the user to reauthenticate, then recheck setup. This request did not start a Run and will not be replayed.',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      next: [
        {
          ...setupAction({ code }, profile),
          owner: 'user',
          requiresUser: true
        }
      ]
    }
  }
}
