// Transport-neutral remote path policy shared by Compute Job command and transfer workflows.
export const GLOB_CHARS = /[*?[\]{}\\]/

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
