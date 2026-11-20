/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url))

export const setupAction = ({ code, argv }, profile) => {
  const runtime = code.startsWith('runtime_')
  const prepare = runtime && argv?.[0] === 'runtime' && argv[1] === 'install' && argv[2] === 'codex'
  const login = !runtime && argv?.[0] === 'codex' && argv[1] === 'login'
  const action = prepare ? 'prepare_runtime' : login ? 'provider_login' : 'open_settings'
  const userCommand = login
    ? ['codex', 'login', ...(argv[2] === '--force' ? ['--force'] : [])]
    : ['url']
  return {
    code,
    action,
    owner: prepare ? 'agent' : 'user',
    requiresUser: !prepare,
    retryable: false,
    message: prepare
      ? 'Prepare the managed Codex runtime through Open-Science.'
      : login
        ? 'Ask the user to run the Open-Science Codex login command for this profile.'
        : `Ask the user to open Open-Science Settings for this profile and check the ${runtime ? 'Agent runtime' : 'model provider'}.`,
    ...(!prepare
      ? {
          executable: process.execPath,
          argv: [cliPath, ...userCommand, ...(profile ? ['--profile', profile] : [])],
          ...(profile ? { cwd: profile } : {})
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
        'The model provider requires authentication. Ask the user to fix it in Open-Science, then recheck setup. This request did not start a Run and will not be replayed.',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      next: [setupAction({ code }, profile)]
    }
  }
}
