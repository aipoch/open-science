// Transport-neutral remote path policy shared by Compute Job command and transfer workflows.
export const GLOB_CHARS = /[*?[\]{}\\]/

export const SSH_ALIAS_MAX_LENGTH = 255
export const SCRATCH_ROOT_MAX_LENGTH = 4096

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

export const assertSafeSshAlias = (value: string): string => {
  const alias = value.trim()
  if (
    !alias ||
    alias.length > SSH_ALIAS_MAX_LENGTH ||
    alias.startsWith('-') ||
    alias === '.' ||
    alias === '..' ||
    CONTROL_CHARS.test(value) ||
    /[\s/\\%]/u.test(alias)
  ) {
    throw new Error(
      `SSH host alias must contain 1–${SSH_ALIAS_MAX_LENGTH} characters and cannot start with "-" or contain whitespace, path separators, or "%".`
    )
  }
  return alias
}

export const assertSafeScratchRoot = (value: string): string => {
  const invalidMessage = `Scratch root must be a canonical absolute or ~/ path of at most ${SCRATCH_ROOT_MAX_LENGTH} characters.`
  if (!value || value.length > SCRATCH_ROOT_MAX_LENGTH || CONTROL_CHARS.test(value)) {
    throw new Error(invalidMessage)
  }
  if (value === '/' || value === '~') return value

  const suffix = value.startsWith('/')
    ? value.slice(1)
    : value.startsWith('~/')
      ? value.slice(2)
      : ''
  if (!suffix || suffix.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(invalidMessage)
  }
  return value
}

// eslint-disable-next-line no-control-regex
export const SHELL_UNSAFE_CHARS = /[$`;|&<>()"'\x00-\x1f\x7f]/

export const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export const quoteRemotePath = (value: string): string => {
  if (value === '~') return '~'
  if (value.startsWith('~/')) return `~/${shellSingleQuote(value.slice(2))}`
  return shellSingleQuote(value)
}

export const validateRelativeTransferPath = (path: string): string | undefined => {
  if (!path) return 'empty path'
  if (path.startsWith('/')) return 'absolute path not allowed'
  if (path.split('/').some((part) => part === '..')) return 'path traversal not allowed'
  if (GLOB_CHARS.test(path)) return 'glob characters not allowed'
  if (SHELL_UNSAFE_CHARS.test(path)) return 'shell-unsafe characters in path'
  return undefined
}
