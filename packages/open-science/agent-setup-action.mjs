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
        : 'open_setup'
  return {
    code,
    action,
    owner: prepare || action === 'open_setup' ? 'agent' : 'user',
    requiresUser: Boolean(login || choose),
    retryable: false,
    message: prepare
      ? 'Prepare this selected Agent runtime through Open-Science.'
      : login
        ? 'Open this profile in Web or use the installed sign-in command. The user completes Codex sign-in.'
        : choose
          ? 'List the available providers and ask the user which provider and model to use.'
          : 'Review provider options in this profile. For a provider that needs user sign-in, open the same profile and let the user sign in.',
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
          argv: [cliPath, 'codex', 'login', '--force', ...(profile ? ['--profile', profile] : [])]
        }
      : {}),
    ...(!prepare ? { web: { capability: 'open_setup' } } : {}),
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
        'The model provider requires authentication. Ask the user to fix it in Open-Science, then recheck setup. This request did not start a Run and will not be replayed.',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      next: [
        {
          ...setupAction({ code }, profile),
          action: 'open_setup',
          owner: 'user',
          requiresUser: true
        }
      ]
    }
  }
}
