import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The Claude Agent SDK spawns CLAUDE_CODE_EXECUTABLE directly for native executables, but runs a JS
// entry through node when the path ends in .js/.mjs/.ts/etc. (it inspects the extension). On Windows an
// npm-installed claude is a `claude.cmd` batch shim, and Node refuses to spawn a .cmd/.bat without a
// shell — so the SDK's direct spawn fails with `spawn EINVAL` (Node CVE-2024-27980 behaviour), which
// surfaces as "agent session could not be created".
//
// Resolving the shim to the underlying cli.js it wraps makes the SDK launch it via node instead, which
// works. A native `claude.exe` (from the PowerShell installer) is already directly spawnable, and
// non-Windows paths (a shebang `claude` script on macOS/Linux) run directly too — both pass through
// unchanged. If the cli.js cannot be located the original path is returned (no worse than before).

type ResolveDeps = {
  exists: (path: string) => boolean
  readText: (path: string) => string
}

const defaultDeps: ResolveDeps = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf8')
}

// Reads the claude-code package's `bin` entry (string or { claude } map) to find its CLI script name.
const readBinEntry = (packageDir: string, deps: ResolveDeps): string | undefined => {
  try {
    const pkg = JSON.parse(deps.readText(join(packageDir, 'package.json'))) as {
      bin?: string | Record<string, string>
    }

    if (typeof pkg.bin === 'string') return pkg.bin
    if (pkg.bin && typeof pkg.bin === 'object') return pkg.bin.claude ?? Object.values(pkg.bin)[0]

    return undefined
  } catch {
    return undefined
  }
}

const resolveClaudeExecutableForSpawn = (
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  deps: ResolveDeps = defaultDeps
): string => {
  if (platform !== 'win32') return executablePath

  const lower = executablePath.toLowerCase()
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return executablePath

  // npm global layout: <prefix>\claude.cmd  ->  <prefix>\node_modules\@anthropic-ai\claude-code\<bin>
  const packageDir = join(dirname(executablePath), 'node_modules', '@anthropic-ai', 'claude-code')

  const binEntry = readBinEntry(packageDir, deps)
  if (binEntry) {
    const cliPath = join(packageDir, binEntry)
    if (deps.exists(cliPath)) return cliPath
  }

  // Fall back to the conventional entry name when package.json can't be read.
  const conventional = join(packageDir, 'cli.js')
  if (deps.exists(conventional)) return conventional

  return executablePath
}

export { resolveClaudeExecutableForSpawn }
