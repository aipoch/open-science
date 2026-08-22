/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync } = require('node:fs')
const path = require('node:path')

const DEFAULT_WEB_PORT = '44110'
const MARKER = path.join('src', 'main', 'acp', 'native-follow-up.ts')

const resolveClaudeAgentAcpVersion = (root) => {
  try {
    return readFileSync(
      path.join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'),
      'utf8'
    ).match(/"version"\s*:\s*"([^"]+)"/)?.[1]
  } catch {
    return undefined
  }
}

const resolveGitIdentity = (root) => {
  const run = (args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim() || undefined
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: run(['rev-parse', '--short', 'HEAD'])
  }
}

const assertWorktree = (root) => {
  if (!existsSync(path.join(root, MARKER))) {
    throw new Error(
      `This launcher is only for the native-send-now worktree. Missing ${MARKER} under ${root}.\n` +
        'Use: cd .worktree/message-queue-native-send-now && npm run dev:native-send-now'
    )
  }
}

const buildNativeSendNowLaunch = (root, env = {}) => {
  assertWorktree(root)
  const isolateRoot = path.join(root, '.dev-isolate')
  const storageRoot = path.join(isolateRoot, 'storage')
  const userData = path.join(isolateRoot, 'electron-user-data')
  const port = env.OPEN_SCIENCE_WEB_PORT?.trim() || DEFAULT_WEB_PORT
  mkdirSync(storageRoot, { recursive: true })
  mkdirSync(userData, { recursive: true })
  const identity = {
    ...resolveGitIdentity(root),
    claudeAgentAcp: resolveClaudeAgentAcpVersion(root),
    cwd: root,
    port,
    storageRoot,
    userData
  }
  return {
    command: 'npx',
    args: ['electron-vite', 'dev'],
    env: {
      ...env,
      OPEN_SCIENCE_WEB_PORT: port,
      OPEN_SCIENCE_STORAGE_ROOT: storageRoot,
      OPEN_SCIENCE_E2E_STORAGE_ROOT: storageRoot,
      OPEN_SCIENCE_USER_DATA: userData,
      OPEN_SCIENCE_ALLOW_MULTI_INSTANCE: '1'
    },
    identity
  }
}

const printIdentity = (identity) => {
  const lines = [
    '',
    '=== native-send-now isolated launch ===',
    `cwd            ${identity.cwd}`,
    `branch         ${identity.branch ?? '(unknown)'}`,
    `commit         ${identity.commit ?? '(unknown)'}`,
    `claude-acp     ${identity.claudeAgentAcp ?? '(missing node_modules)'}`,
    `web            http://127.0.0.1:${identity.port}`,
    `storage        ${identity.storageRoot}`,
    `userData       ${identity.userData}`,
    '',
    'Fresh profile: not ~/OpenScience-DEV. Reconfigure Codex here; 1.6.2 installs on first use.',
    'Do not use `npm run dev` from the repo root — that is the old 0.60.0 host.',
    'Look for [acp] native follow-up injected|refused in this terminal after Send now.',
    '=======================================',
    ''
  ]
  process.stderr.write(lines.join('\n'))
}

const main = () => {
  const root = path.join(__dirname, '..')
  const { command, args, env, identity } = buildNativeSendNowLaunch(root, process.env)
  printIdentity(identity)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  })
  process.exit(result.status ?? 1)
}

if (require.main === module) main()

module.exports = {
  DEFAULT_WEB_PORT,
  MARKER,
  buildNativeSendNowLaunch,
  resolveClaudeAgentAcpVersion
}
