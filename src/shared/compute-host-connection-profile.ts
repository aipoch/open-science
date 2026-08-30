const SSH_PORT_MIN = 1
const SSH_PORT_MAX = 65_535
const HOST_CONNECTION_TEXT_MAX_LENGTH = 255

type HostConnectionProfileInput = Readonly<{
  sshAlias: string
  displayName?: string
  user?: string
  port?: string | number
  identityFile?: string
}>

type HostConnectionProfileOptions = Readonly<{
  requireUser?: boolean
  requirePort?: boolean
}>

type HostConnectionProfile = Readonly<{
  sshAlias: string
  displayName: string
  user?: string
  port?: number
  identityFile?: string
}>

class HostConnectionProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostConnectionProfileValidationError'
  }
}

const normalizeHostConnectionText = (
  value: string | undefined,
  label: string,
  required: boolean
): string | undefined => {
  const normalized = value?.trim() ?? ''
  if (
    (required && !normalized) ||
    normalized.length > HOST_CONNECTION_TEXT_MAX_LENGTH ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new HostConnectionProfileValidationError(
      `${label} must contain 1–${HOST_CONNECTION_TEXT_MAX_LENGTH} characters without control characters.`
    )
  }
  return normalized || undefined
}

const parseHostConnectionPort = (value: string | number | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (!/^\d+$/.test(trimmed)) {
      throw new HostConnectionProfileValidationError(
        'Port must be an integer from 1 through 65535.'
      )
    }
    value = Number(trimmed)
  }
  if (!Number.isInteger(value) || value < SSH_PORT_MIN || value > SSH_PORT_MAX) {
    throw new HostConnectionProfileValidationError('Port must be an integer from 1 through 65535.')
  }
  return value
}

const validateHostConnectionProfile = (
  input: HostConnectionProfileInput,
  options: HostConnectionProfileOptions = {}
): HostConnectionProfile => {
  const sshAlias = normalizeHostConnectionText(input.sshAlias, 'SSH alias', true)!
  const displayName =
    normalizeHostConnectionText(input.displayName, 'Display name', false) ?? sshAlias
  const user = normalizeHostConnectionText(input.user, 'Username', options.requireUser === true)
  const identityFile = normalizeHostConnectionText(input.identityFile, 'Identity file', false)
  const port = parseHostConnectionPort(input.port)
  if (options.requirePort && port === undefined) {
    throw new HostConnectionProfileValidationError('Port must be an integer from 1 through 65535.')
  }
  return {
    sshAlias,
    displayName,
    ...(user ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(identityFile ? { identityFile } : {})
  }
}

const isHostConnectionPortValid = (value: string | number | undefined): boolean => {
  try {
    parseHostConnectionPort(value)
    return true
  } catch {
    return false
  }
}

export {
  HostConnectionProfileValidationError,
  isHostConnectionPortValid,
  parseHostConnectionPort,
  validateHostConnectionProfile
}
export type { HostConnectionProfile, HostConnectionProfileInput, HostConnectionProfileOptions }
