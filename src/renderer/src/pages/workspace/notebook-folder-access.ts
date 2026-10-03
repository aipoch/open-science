import type { NotebookRunRecord } from '../../../../shared/notebook'
import { isLocalPathRoot, validateLocalPath } from '../../../../shared/local-fs'

const permissionFailure = String.raw`(?:permission denied|operation not permitted|access is denied|read-only file system)`

const diagnosticLines = (text: string): string[] => {
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const decodedLines: string[] = []
    let index = 0
    while (index < line.length) {
      if (line[index] !== '"') {
        index += 1
        continue
      }
      const start = index++
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2
          continue
        }
        if (line[index] === '"') {
          index += 1
          try {
            const decoded = JSON.parse(line.slice(start, index))
            if (typeof decoded === 'string') decodedLines.push(decoded)
          } catch {
            // Quoted shell output is not necessarily a JSON string.
          }
          break
        }
        index += 1
      }
    }
    lines.push(...decodedLines, line)
  }
  return lines
}

type DiagnosticPathMatch = { path: string; index: number; end: number }

const diagnosticPathMatches = (text: string, quotedOnly = false): DiagnosticPathMatch[] => {
  const tokens = /"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`:]+/g
  const paths: DiagnosticPathMatch[] = []
  for (const match of text.matchAll(tokens)) {
    const quoted = /^["'`]/.test(match[0])
    if (quotedOnly && !quoted) continue
    const candidate = quoted ? match[0].slice(1, -1) : match[0]
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(candidate)) continue
    if (!quoted) {
      if (match.index > 0 && !/[\s:]/.test(text[match.index - 1])) continue
      if (!/^\s*(?::|$)/.test(text.slice(match.index + match[0].length))) continue
    }
    // eslint-disable-next-line no-control-regex
    if (candidate.length > 1000 || /[\u0000-\u001f\u007f]/.test(candidate)) continue
    paths.push({ path: candidate, index: match.index, end: match.index + match[0].length })
  }
  return paths
}

const rawPermissionPaths = (text: string): string[] => {
  const failurePattern = new RegExp(permissionFailure, 'gi')
  const paths: string[] = []
  for (const line of diagnosticLines(text)) {
    const candidates = diagnosticPathMatches(line, true)
    const failures = [...line.matchAll(failurePattern)]
    failures.forEach((_, index) => {
      const segmentStart =
        index === 0 ? 0 : (failures[index - 1].index ?? 0) + failures[index - 1][0].length
      const segmentEnd =
        index + 1 < failures.length ? (failures[index + 1].index ?? line.length) : line.length
      for (const candidate of candidates) {
        if (candidate.index >= segmentStart && candidate.end <= segmentEnd)
          paths.push(candidate.path)
      }
    })
  }
  return paths
}

// A diagnostic is a navigation suggestion, never proof of a sandbox denial or authority to grant.
// Prefer the runtime annotation, but recover a quoted absolute path from a raw permission error
// when a platform launcher could not attach the structured annotation.
export const notebookFolderAccessPath = (
  run: NotebookRunRecord,
  platform: string
): string | undefined => {
  if (
    run.status !== 'failed' &&
    !(run.status === 'completed' && typeof run.exitCode === 'number' && run.exitCode !== 0)
  )
    return undefined
  if (run.shellRuntime?.kind === 'wsl2-bash') return undefined
  const diagnostics = [
    run.text.stderr,
    run.text.traceback,
    ...run.outputs.flatMap((output) =>
      output.type === 'stream' && output.name === 'stderr'
        ? [output.text]
        : output.type === 'error'
          ? [output.message ?? '', output.traceback ?? '']
          : []
    )
  ]
  const paths = new Set<string>()
  const structuredDiagnostics = [
    run.text.stderr,
    run.text.traceback,
    ...run.outputs.flatMap((output) =>
      output.type === 'stream' && output.name === 'stderr'
        ? [output.text]
        : output.type === 'error'
          ? [output.message ?? '', output.traceback ?? '']
          : []
    )
  ]
  for (const text of structuredDiagnostics) {
    for (const block of text.matchAll(
      /<sandbox_violations>\r?\n([\s\S]*?)\r?\n<\/sandbox_violations>/g
    )) {
      for (const line of block[1].split(/\r?\n/)) {
        const match =
          /^OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: (.+) Filesystem access failed; native permissions, read-only mounts, or the sandbox may be responsible\./.exec(
            line
          )
        if (!match) continue
        const path = match[1]
        if (validateLocalPath(path, platform) !== undefined || isLocalPathRoot(path, platform)) {
          return undefined
        }
        paths.add(path)
      }
    }
  }
  if (paths.size > 0) return paths.size === 1 ? [...paths][0] : undefined

  const rawPaths = new Set(diagnostics.flatMap(rawPermissionPaths))
  for (const path of rawPaths) {
    if (validateLocalPath(path, platform) !== undefined || isLocalPathRoot(path, platform)) {
      return undefined
    }
  }
  return rawPaths.size === 1 ? [...rawPaths][0] : undefined
}
