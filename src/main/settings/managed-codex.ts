import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, type Dirent } from 'node:fs'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { arch as osArch } from 'node:os'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'

import type { ClaudeInstallEvent, ClaudeInstallResult } from '../../shared/settings'
import {
  ACP_MODEL_CALL_USAGE_META_KEY,
  ACP_MODEL_TURN_COUNT_META_KEY,
  ACP_TURN_TOKEN_USAGE_META_KEY
} from '../../shared/acp'
import { MINIMUM_CODEX_ACP_VERSION } from '../../shared/codex-runtime'
import {
  DEFAULT_REGISTRIES,
  defaultFetchJson,
  defaultFetchTarball,
  downloadAndVerify,
  extractFileFromTgz,
  type FetchJson,
  type FetchTarball
} from './managed-claude'
import { createLogger } from '../logger'
import { stripCodexCredentialEnv } from './process-tree'
import { terminateProcessTree } from '../process-tree'
import { toErrorMessage } from '../error-message'

const execFileAsync = promisify(execFile)

export const CODEX_ACP_VERSION = MINIMUM_CODEX_ACP_VERSION
export const CODEX_VERSION = '0.144.6'

const log = createLogger('managed-codex')
const MAX_INITIALIZE_DIAGNOSTIC_CHARS = 4 * 1024

export const CODEX_ACP_INTEGRITY =
  'sha512-2eF1mbs1gTqkZJSLYOun/pFDx37sYa7W63HOPezC37b/R8AYms5O1nfQu8lrqFSGDrwDZkASVORymLcqjCNqyA=='

export const CODEX_INTEGRITIES: Readonly<Record<string, string>> = {
  'darwin-arm64':
    'sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==',
  'darwin-x64':
    'sha512-THRyPG0zSU6M8NQAge1LHEHsJDnoH4BpKsfJHB/qe3Fm+Wf6zqAmWJFlOKzBm27m0K2Hq3za4Ac2I5p5i4yp/A==',
  'linux-arm64':
    'sha512-PGiLXMN+2IQRkf7tOLi64dMInjU1pRLbz0Rwfj/yt2Y97SZQqAjFQoi2wmswmqtqMDnfwCPTC1DRXVQkvU6T6Q==',
  'linux-x64':
    'sha512-4E7EnzCg0OnBxCyYnwJ+qnZwWHYe0YScr5ucKWbngE9u4+0XrpWELqq2Kn9jl5GZK8MDjU7PrJwFIwusHOHjuw==',
  'win32-arm64':
    'sha512-SpMjXJLW43JzMP0K62mVcYfmFcpk0BK4AOgYmWSfyZHs3iRtHMd0UYw7605n/9lwkT2EqbwQLT2omZFeKJFzwA==',
  'win32-x64':
    'sha512-dN39VnjEthKz5io1RNWwZDtErdSn07nW3pGUgvlA6DMxgm/nuGaIAZO/sG/Hgxq/x5j9HteAENfrFgVkpZ0lFg=='
}

export type ManagedCodexPlatform = {
  key: string
  target: string
  binName: string
}

export type ResolveManagedCodexPlatformDeps = {
  platform?: NodeJS.Platform
  arch?: string
}

const PLATFORM_TARGETS: Record<string, Omit<ManagedCodexPlatform, 'key'>> = {
  'darwin-x64': { target: 'x86_64-apple-darwin', binName: 'codex' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', binName: 'codex' },
  'linux-x64': { target: 'x86_64-unknown-linux-musl', binName: 'codex' },
  'linux-arm64': { target: 'aarch64-unknown-linux-musl', binName: 'codex' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', binName: 'codex.exe' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', binName: 'codex.exe' }
}

export const resolveManagedCodexPlatform = (
  deps: ResolveManagedCodexPlatformDeps = {}
): ManagedCodexPlatform => {
  const key = `${deps.platform ?? process.platform}-${deps.arch ?? osArch()}`
  const target = PLATFORM_TARGETS[key]

  if (!target) {
    throw new Error(`Unsupported platform for the app-managed Codex install: ${key}`)
  }

  return { key, ...target }
}

export const managedCodexRoot = (dataRoot: string): string => join(dataRoot, 'codex-managed')

export const managedCodexAdapterEntry = (dataRoot: string): string =>
  join(managedCodexRoot(dataRoot), 'adapter', 'dist', 'index.js')

export const managedCodexBinary = (
  dataRoot: string,
  platform: ManagedCodexPlatform = resolveManagedCodexPlatform()
): string =>
  join(managedCodexRoot(dataRoot), 'codex', 'vendor', platform.target, 'bin', platform.binName)

const adapterEntryInRoot = (root: string): string => join(root, 'adapter', 'dist', 'index.js')

const codexBinaryInRoot = (root: string, platform: ManagedCodexPlatform): string =>
  join(root, 'codex', 'vendor', platform.target, 'bin', platform.binName)

const CODEX_ACP_CONTEXT_USAGE_SOURCE =
  '    const used = this.sessionState.lastTokenUsage?.totalTokens;'
const CODEX_ACP_CONTEXT_USAGE_LEGACY_REPLACEMENT = [
  '    const lastTokenUsage = this.sessionState.lastTokenUsage;',
  '    const used =',
  '      lastTokenUsage == null',
  '        ? void 0',
  '        : lastTokenUsage.inputTokens + (lastTokenUsage.cachedInputTokens ?? 0);'
].join('\n')
const CODEX_ACP_CONTEXT_USAGE_REPLACEMENT = [
  '    const contextTokenUsage = this.sessionState.lastTokenUsage;',
  '    const used =',
  '      contextTokenUsage == null',
  '        ? void 0',
  '        : contextTokenUsage.inputTokens + (contextTokenUsage.cachedInputTokens ?? 0);'
].join('\n')
const CODEX_ACP_CONTEXT_USAGE_INPUT_ONLY_REPLACEMENT = [
  '    const contextTokenUsage = this.sessionState.lastTokenUsage;',
  '    const used =',
  '      contextTokenUsage == null',
  '        ? void 0',
  '        : contextTokenUsage.inputTokens;'
].join('\n')

const CODEX_ACP_TURN_USAGE_UPDATE_SOURCE = [
  '  createUsageUpdate(params) {',
  '    this.handleTokenUsageUpdated(params);'
].join('\n')
const CODEX_ACP_TURN_USAGE_UPDATE_LEGACY_REPLACEMENT = [
  '  createUsageUpdate(params) {',
  '    const previousTotalTokenUsage = this.sessionState.totalTokenUsage;',
  '    this.handleTokenUsageUpdated(params);',
  '    const currentTotalTokenUsage = this.sessionState.totalTokenUsage;',
  '    const lastTokenUsage = this.sessionState.lastTokenUsage;',
  '    const promptTokenUsage = this.sessionState.promptTokenUsage;',
  '    if (',
  '      promptTokenUsage != null &&',
  '      currentTotalTokenUsage != null &&',
  '      lastTokenUsage != null',
  '    ) {',
  '      const tokenKeys = [',
  '        "totalTokens",',
  '        "inputTokens",',
  '        "cachedInputTokens",',
  '        "outputTokens",',
  '        "reasoningOutputTokens"',
  '      ];',
  '      const cumulativeDelta = previousTotalTokenUsage == null',
  '        ? lastTokenUsage',
  '        : {',
  '            totalTokens: currentTotalTokenUsage.totalTokens - previousTotalTokenUsage.totalTokens,',
  '            inputTokens: currentTotalTokenUsage.inputTokens - previousTotalTokenUsage.inputTokens,',
  '            cachedInputTokens:',
  '              currentTotalTokenUsage.cachedInputTokens - previousTotalTokenUsage.cachedInputTokens,',
  '            outputTokens:',
  '              currentTotalTokenUsage.outputTokens - previousTotalTokenUsage.outputTokens,',
  '            reasoningOutputTokens:',
  '              currentTotalTokenUsage.reasoningOutputTokens -',
  '              previousTotalTokenUsage.reasoningOutputTokens',
  '          };',
  '      const increment = tokenKeys.every(',
  '        (key) => Number.isSafeInteger(cumulativeDelta[key]) && cumulativeDelta[key] >= 0',
  '      )',
  '        ? cumulativeDelta',
  '        : lastTokenUsage;',
  '      const nextPromptTokenUsage = {',
  '        totalTokens: promptTokenUsage.totalTokens + increment.totalTokens,',
  '        inputTokens: promptTokenUsage.inputTokens + increment.inputTokens,',
  '        cachedInputTokens: promptTokenUsage.cachedInputTokens + increment.cachedInputTokens,',
  '        outputTokens: promptTokenUsage.outputTokens + increment.outputTokens,',
  '        reasoningOutputTokens:',
  '          promptTokenUsage.reasoningOutputTokens + increment.reasoningOutputTokens',
  '      };',
  '      if (tokenKeys.every((key) => Number.isSafeInteger(nextPromptTokenUsage[key]))) {',
  '        this.sessionState.promptTokenUsage = nextPromptTokenUsage;',
  '        this.sessionState.promptTokenUsageObserved = true;',
  '      }',
  '    }'
].join('\n')

const CODEX_ACP_TURN_USAGE_UPDATE_WITHOUT_COUNT_REPLACEMENT = [
  '  createUsageUpdate(params) {',
  '    const normalizeTokenUsage = (usage) =>',
  '      usage == null',
  '        ? usage',
  '        : { ...usage, cachedInputTokens: usage.cachedInputTokens ?? 0 };',
  '    const previousTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);',
  '    this.handleTokenUsageUpdated(params);',
  '    const currentTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);',
  '    const lastTokenUsage = normalizeTokenUsage(this.sessionState.lastTokenUsage);',
  '    const promptTokenUsage = this.sessionState.promptTokenUsage;',
  '    if (',
  '      promptTokenUsage != null &&',
  '      currentTotalTokenUsage != null &&',
  '      lastTokenUsage != null',
  '    ) {',
  '      const tokenKeys = [',
  '        "totalTokens",',
  '        "inputTokens",',
  '        "cachedInputTokens",',
  '        "outputTokens",',
  '        "reasoningOutputTokens"',
  '      ];',
  '      const cumulativeDelta = previousTotalTokenUsage == null',
  '        ? lastTokenUsage',
  '        : {',
  '            totalTokens: currentTotalTokenUsage.totalTokens - previousTotalTokenUsage.totalTokens,',
  '            inputTokens: currentTotalTokenUsage.inputTokens - previousTotalTokenUsage.inputTokens,',
  '            cachedInputTokens:',
  '              currentTotalTokenUsage.cachedInputTokens - previousTotalTokenUsage.cachedInputTokens,',
  '            outputTokens:',
  '              currentTotalTokenUsage.outputTokens - previousTotalTokenUsage.outputTokens,',
  '            reasoningOutputTokens:',
  '              currentTotalTokenUsage.reasoningOutputTokens -',
  '              previousTotalTokenUsage.reasoningOutputTokens',
  '          };',
  '      const increment = tokenKeys.every(',
  '        (key) => Number.isSafeInteger(cumulativeDelta[key]) && cumulativeDelta[key] >= 0',
  '      )',
  '        ? cumulativeDelta',
  '        : lastTokenUsage;',
  '      const nextPromptTokenUsage = {',
  '        totalTokens: promptTokenUsage.totalTokens + increment.totalTokens,',
  '        inputTokens: promptTokenUsage.inputTokens + increment.inputTokens,',
  '        cachedInputTokens: promptTokenUsage.cachedInputTokens + increment.cachedInputTokens,',
  '        outputTokens: promptTokenUsage.outputTokens + increment.outputTokens,',
  '        reasoningOutputTokens:',
  '          promptTokenUsage.reasoningOutputTokens + increment.reasoningOutputTokens',
  '      };',
  '      if (tokenKeys.every((key) => Number.isSafeInteger(nextPromptTokenUsage[key]))) {',
  '        this.sessionState.promptTokenUsage = nextPromptTokenUsage;',
  '        this.sessionState.promptTokenUsageObserved = true;',
  '      }',
  '    }'
].join('\n')
const CODEX_ACP_TURN_USAGE_UPDATE_WITH_COUNT_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_UPDATE_WITHOUT_COUNT_REPLACEMENT.replace(
    '    const promptTokenUsage = this.sessionState.promptTokenUsage;',
    [
      '    const promptTokenUsage = this.sessionState.promptTokenUsage;',
      '    const promptModelTurnCount = this.sessionState.promptModelTurnCount;'
    ].join('\n')
  )
    .replace(
      '      lastTokenUsage != null\n    ) {',
      '      lastTokenUsage != null &&\n      Number.isSafeInteger(promptModelTurnCount)\n    ) {'
    )
    .replace(
      '      const nextPromptTokenUsage = {',
      [
        '      const observedModelTurn = tokenKeys.some((key) => increment[key] > 0);',
        '      const nextPromptModelTurnCount = promptModelTurnCount + (observedModelTurn ? 1 : 0);',
        '      const nextPromptTokenUsage = {'
      ].join('\n')
    )
    .replace(
      '      if (tokenKeys.every((key) => Number.isSafeInteger(nextPromptTokenUsage[key]))) {',
      [
        '      if (',
        '        tokenKeys.every((key) => Number.isSafeInteger(nextPromptTokenUsage[key])) &&',
        '        Number.isSafeInteger(nextPromptModelTurnCount)',
        '      ) {'
      ].join('\n')
    )
    .replace(
      '        this.sessionState.promptTokenUsage = nextPromptTokenUsage;',
      [
        '        this.sessionState.promptTokenUsage = nextPromptTokenUsage;',
        '        this.sessionState.promptModelTurnCount = nextPromptModelTurnCount;'
      ].join('\n')
    )
const CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_UPDATE_WITH_COUNT_REPLACEMENT.replace(
    '    const promptModelTurnCount = this.sessionState.promptModelTurnCount;',
    [
      '    const promptModelTurnCount = this.sessionState.promptModelTurnCount;',
      '    const promptModelCalls = this.sessionState.promptModelCalls;'
    ].join('\n')
  )
    .replace(
      '      Number.isSafeInteger(promptModelTurnCount)\n    ) {',
      '      Number.isSafeInteger(promptModelTurnCount) &&\n      Array.isArray(promptModelCalls)\n    ) {'
    )
    .replace(
      '      const nextPromptModelTurnCount = promptModelTurnCount + (observedModelTurn ? 1 : 0);',
      [
        '      const nextPromptModelTurnCount = promptModelTurnCount + (observedModelTurn ? 1 : 0);',
        '      const nextPromptModelCalls = observedModelTurn',
        '        ? [...promptModelCalls, increment]',
        '        : promptModelCalls;'
      ].join('\n')
    )
    .replace(
      '        Number.isSafeInteger(nextPromptModelTurnCount)\n      ) {',
      '        Number.isSafeInteger(nextPromptModelTurnCount) &&\n        nextPromptModelCalls.length === nextPromptModelTurnCount\n      ) {'
    )
    .replace(
      '        this.sessionState.promptModelTurnCount = nextPromptModelTurnCount;',
      [
        '        this.sessionState.promptModelTurnCount = nextPromptModelTurnCount;',
        '        this.sessionState.promptModelCalls = nextPromptModelCalls;'
      ].join('\n')
    )
const CODEX_ACP_TURN_USAGE_UPDATE_LEGACY_WITH_COUNT_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_UPDATE_WITH_COUNT_REPLACEMENT.replace(
    [
      '    const normalizeTokenUsage = (usage) =>',
      '      usage == null',
      '        ? usage',
      '        : { ...usage, cachedInputTokens: usage.cachedInputTokens ?? 0 };',
      '    const previousTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);'
    ].join('\n'),
    '    const previousTotalTokenUsage = this.sessionState.totalTokenUsage;'
  )
    .replace(
      '    const currentTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);',
      '    const currentTotalTokenUsage = this.sessionState.totalTokenUsage;'
    )
    .replace(
      '    const lastTokenUsage = normalizeTokenUsage(this.sessionState.lastTokenUsage);',
      '    const lastTokenUsage = this.sessionState.lastTokenUsage;'
    )
const CODEX_ACP_TURN_USAGE_UPDATE_LEGACY_WITH_CALLS_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT.replace(
    [
      '    const normalizeTokenUsage = (usage) =>',
      '      usage == null',
      '        ? usage',
      '        : { ...usage, cachedInputTokens: usage.cachedInputTokens ?? 0 };',
      '    const previousTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);'
    ].join('\n'),
    '    const previousTotalTokenUsage = this.sessionState.totalTokenUsage;'
  )
    .replace(
      '    const currentTotalTokenUsage = normalizeTokenUsage(this.sessionState.totalTokenUsage);',
      '    const currentTotalTokenUsage = this.sessionState.totalTokenUsage;'
    )
    .replace(
      '    const lastTokenUsage = normalizeTokenUsage(this.sessionState.lastTokenUsage);',
      '    const lastTokenUsage = this.sessionState.lastTokenUsage;'
    )

const CODEX_ACP_TURN_USAGE_START_SOURCE = [
  '    sessionState.currentTurnId = null;',
  '    sessionState.lastTokenUsage = null;'
].join('\n')
const CODEX_ACP_TURN_USAGE_START_WITHOUT_COUNT_REPLACEMENT = [
  CODEX_ACP_TURN_USAGE_START_SOURCE,
  '    sessionState.promptTokenUsage = {',
  '      totalTokens: 0,',
  '      inputTokens: 0,',
  '      cachedInputTokens: 0,',
  '      outputTokens: 0,',
  '      reasoningOutputTokens: 0',
  '    };',
  '    sessionState.promptTokenUsageObserved = false;'
].join('\n')
const CODEX_ACP_TURN_USAGE_START_WITH_COUNT_REPLACEMENT = [
  CODEX_ACP_TURN_USAGE_START_WITHOUT_COUNT_REPLACEMENT,
  '    sessionState.promptModelTurnCount = 0;'
].join('\n')
const CODEX_ACP_TURN_USAGE_START_REPLACEMENT = [
  CODEX_ACP_TURN_USAGE_START_WITH_COUNT_REPLACEMENT,
  '    sessionState.promptModelCalls = [];'
].join('\n')

const CODEX_ACP_TURN_USAGE_RESPONSE_SOURCE =
  'usage: this.buildPromptUsage(sessionState.lastTokenUsage),'
const CODEX_ACP_TURN_USAGE_RESPONSE_LEGACY_REPLACEMENT =
  'usage: this.buildPromptUsage(sessionState.promptTokenUsageObserved ? sessionState.promptTokenUsage : null),'
// The first turn-usage patch emitted a second `_meta` property immediately before the adapter's
// existing quota metadata. JavaScript keeps only the latter property, so this exact shape must be
// recognized and upgraded in already-managed installs.
const CODEX_ACP_TURN_USAGE_RESPONSE_OVERWRITTEN_REPLACEMENT = [
  'usage: this.buildPromptUsage(',
  '  sessionState.lastTokenUsage',
  '),',
  '...(sessionState.promptTokenUsageObserved',
  '  ? {',
  '      _meta: {',
  `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage)`,
  '      }',
  '    }',
  '  : {}),'
].join('\n')
const CODEX_ACP_TURN_USAGE_RESPONSE_OVERWRITTEN_WITH_COUNT_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_RESPONSE_OVERWRITTEN_REPLACEMENT.replace(
    `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage)`,
    [
      `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage),`,
      `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount`
    ].join('\n')
  )
const CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT = [
  'usage: this.buildPromptUsage(',
  '  sessionState.lastTokenUsage',
  '),'
].join('\n')
const CODEX_ACP_TURN_USAGE_META_SOURCE = '_meta: this.buildQuotaMeta(sessionState)'
const CODEX_ACP_TURN_USAGE_META_WITHOUT_COUNT_REPLACEMENT = [
  '_meta: {',
  '  ...this.buildQuotaMeta(sessionState),',
  '  ...(sessionState.promptTokenUsageObserved',
  '    ? {',
  `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage)`,
  '      }',
  '    : {})',
  '}'
].join('\n')
const CODEX_ACP_TURN_USAGE_META_WITH_COUNT_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_META_WITHOUT_COUNT_REPLACEMENT.replace(
    `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage)`,
    [
      `        "${ACP_TURN_TOKEN_USAGE_META_KEY}": this.buildPromptUsage(sessionState.promptTokenUsage),`,
      `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount`
    ].join('\n')
  )
const CODEX_ACP_TURN_USAGE_META_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_META_WITH_COUNT_REPLACEMENT.replace(
    `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount`,
    [
      `        "${ACP_MODEL_TURN_COUNT_META_KEY}": sessionState.promptModelTurnCount,`,
      `        "${ACP_MODEL_CALL_USAGE_META_KEY}": sessionState.promptModelCalls.map((usage) => this.buildPromptUsage(usage))`
    ].join('\n')
  )
const CODEX_ACP_TURN_USAGE_FINISH_SOURCE = '      activePrompt.complete();'
const CODEX_ACP_TURN_USAGE_FINISH_WITHOUT_COUNT_REPLACEMENT = [
  '      sessionState.promptTokenUsage = void 0;',
  '      sessionState.promptTokenUsageObserved = void 0;',
  CODEX_ACP_TURN_USAGE_FINISH_SOURCE
].join('\n')
const CODEX_ACP_TURN_USAGE_FINISH_WITH_COUNT_REPLACEMENT = [
  '      sessionState.promptTokenUsage = void 0;',
  '      sessionState.promptTokenUsageObserved = void 0;',
  '      sessionState.promptModelTurnCount = void 0;',
  CODEX_ACP_TURN_USAGE_FINISH_SOURCE
].join('\n')
const CODEX_ACP_TURN_USAGE_FINISH_REPLACEMENT =
  CODEX_ACP_TURN_USAGE_FINISH_WITH_COUNT_REPLACEMENT.replace(
    '      sessionState.promptModelTurnCount = void 0;',
    [
      '      sessionState.promptModelTurnCount = void 0;',
      '      sessionState.promptModelCalls = void 0;'
    ].join('\n')
  )

const CODEX_ACP_SKILL_INPUT_SOURCE = [
  'function buildPromptItems(prompt) {',
  '  return prompt.map((block) => {',
  '    switch (block.type) {',
  '      case "text":',
  '        return { type: "text", text: block.text, text_elements: [] };'
].join('\n')

const CODEX_ACP_SKILL_INPUT_REPLACEMENT = [
  'function buildPromptItems(prompt) {',
  '  return prompt.flatMap((block) => {',
  '    switch (block.type) {',
  '      case "text": {',
  '        const requestedSkills = Array.isArray(block._meta?.["open-science/skill-inputs"])',
  '          ? block._meta["open-science/skill-inputs"]',
  '          : [];',
  '        const codexHome = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME : "";',
  '        const skillRoot = codexHome ? path4.join(codexHome, "skills") : "";',
  '        const seen = new Set();',
  '        const nativeSkills = requestedSkills.flatMap((skill) => {',
  '          const name = typeof skill?.name === "string" ? skill.name.trim() : "";',
  '          const skillPath = typeof skill?.path === "string" ? skill.path.trim() : "";',
  '          const relative = skillRoot && path4.isAbsolute(skillPath)',
  '            ? path4.relative(skillRoot, skillPath)',
  '            : "..";',
  '          let realRelative = "..";',
  '          try {',
  '            realRelative = path4.relative(fs4.realpathSync(skillRoot), fs4.realpathSync(skillPath));',
  '          } catch {}',
  '          const key = name + "\\0" + skillPath;',
  '          if (',
  '            !name ||',
  '            !skillRoot ||',
  '            relative === "" ||',
  '            relative === ".." ||',
  '            relative.startsWith(".." + path4.sep) ||',
  '            path4.isAbsolute(relative) ||',
  '            realRelative === ".." ||',
  '            realRelative.startsWith(".." + path4.sep) ||',
  '            path4.isAbsolute(realRelative) ||',
  '            path4.basename(skillPath) !== "SKILL.md" ||',
  '            !fs4.existsSync(skillPath) ||',
  '            seen.has(key)',
  '          ) return [];',
  '          seen.add(key);',
  '          return [{ type: "skill", name, path: skillPath }];',
  '        });',
  '        return [...nativeSkills, { type: "text", text: block.text, text_elements: [] }];',
  '      }'
].join('\n')

const CODEX_ACP_MODEL_CATALOG_STARTUP_SOURCE = [
  'function startCodexConnection(codexPath, env) {',
  '  const spawnEnv = env ?? process.env;',
  '  let codex;',
  '  if (codexPath) {',
  '    codex = process.platform === "win32" ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv }) : spawn(codexPath, ["app-server"], { env: spawnEnv });',
  '  } else {',
  '    const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");',
  '    codex = spawn(process.execPath, [bundledCodexPath, "app-server"], { env: spawnEnv });',
  '  }'
].join('\n')

const CODEX_ACP_MODEL_CATALOG_STARTUP_REPLACEMENT = [
  'function startCodexConnection(codexPath, env) {',
  '  const spawnEnv = env ?? process.env;',
  '  const startupConfigString = spawnEnv["CODEX_CONFIG"];',
  '  const startupConfig = startupConfigString ? JSON.parse(startupConfigString) : void 0;',
  '  const modelCatalogPath = typeof startupConfig?.model_catalog_json === "string"',
  '    ? startupConfig.model_catalog_json',
  '    : void 0;',
  '  const appServerArgs = modelCatalogPath',
  '    ? ["app-server", "-c", `model_catalog_json=${JSON.stringify(modelCatalogPath)}`]',
  '    : ["app-server"];',
  '  let codex;',
  '  if (codexPath) {',
  '    codex = process.platform === "win32"',
  '      ? spawn(`"${codexPath}" app-server`, appServerArgs.slice(1), { shell: true, env: spawnEnv })',
  '      : spawn(codexPath, appServerArgs, { env: spawnEnv });',
  '  } else {',
  '    const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");',
  '    codex = spawn(process.execPath, [bundledCodexPath, ...appServerArgs], { env: spawnEnv });',
  '  }'
].join('\n')

const CODEX_ADAPTER_REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

const renameWithTransientLockRetry = async (source: string, destination: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      const retryDelay = CODEX_ADAPTER_REPLACE_RETRY_DELAYS_MS[attempt]
      if ((code !== 'EPERM' && code !== 'EBUSY') || retryDelay === undefined) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelay))
    }
  }
}

// codex-acp receives a per-request tokenUsage.last snapshot but publishes totalTokens as ACP context
// usage. Its internal TokenCount has already separated cached input from uncached input, so recombine
// those two input categories while excluding output and reasoning. The registry integrity pin fixes
// the input bundle; the guards make a future source drift fail during installation.
export const patchCodexAcpContextUsageSource = (source: string): string => {
  if (source.includes(CODEX_ACP_CONTEXT_USAGE_REPLACEMENT)) return source
  if (source.includes(CODEX_ACP_CONTEXT_USAGE_INPUT_ONLY_REPLACEMENT)) {
    return source.replace(
      CODEX_ACP_CONTEXT_USAGE_INPUT_ONLY_REPLACEMENT,
      CODEX_ACP_CONTEXT_USAGE_REPLACEMENT
    )
  }
  if (source.includes(CODEX_ACP_CONTEXT_USAGE_LEGACY_REPLACEMENT)) {
    return source.replace(
      CODEX_ACP_CONTEXT_USAGE_LEGACY_REPLACEMENT,
      CODEX_ACP_CONTEXT_USAGE_REPLACEMENT
    )
  }

  const matches = source.split(CODEX_ACP_CONTEXT_USAGE_SOURCE).length - 1

  if (matches === 1) {
    return source.replace(CODEX_ACP_CONTEXT_USAGE_SOURCE, CODEX_ACP_CONTEXT_USAGE_REPLACEMENT)
  }

  if (
    matches > 1 ||
    (source.includes('createUsageUpdate(params)') && source.includes('totalTokens'))
  ) {
    throw new Error('Pinned Codex ACP context-usage patch no longer matches the adapter bundle')
  }

  // Unit-test fixtures use tiny stand-in adapters rather than the pinned production bundle.
  return source
}

// Codex ACP 1.1.4 and 1.6.2 project tokenUsage.last into PromptResponse.usage. Preserve that latest
// request for context reconciliation while accumulating whole-turn deltas into an app-owned _meta
// field for the transcript footer. Falling back to `last` for the first update keeps resumed sessions
// from attributing their historical cumulative total to the first new response.
export const patchCodexAcpTurnUsageSource = (source: string): string => {
  const repairedResponseSource = source
    .replaceAll(
      CODEX_ACP_TURN_USAGE_RESPONSE_OVERWRITTEN_WITH_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT
    )
    .replaceAll(
      CODEX_ACP_TURN_USAGE_RESPONSE_OVERWRITTEN_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT
    )
  if (repairedResponseSource !== source) {
    return patchCodexAcpTurnUsageSource(repairedResponseSource)
  }

  if (
    source.includes(CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT) &&
    source.includes(CODEX_ACP_TURN_USAGE_START_REPLACEMENT) &&
    source.includes(CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT) &&
    source.includes(CODEX_ACP_TURN_USAGE_META_REPLACEMENT) &&
    source.includes(CODEX_ACP_TURN_USAGE_FINISH_REPLACEMENT)
  ) {
    return source
  }

  const sourceWithCurrentStart = source.includes(CODEX_ACP_TURN_USAGE_START_REPLACEMENT)
    ? source
    : source
        .replace(
          CODEX_ACP_TURN_USAGE_START_WITH_COUNT_REPLACEMENT,
          CODEX_ACP_TURN_USAGE_START_REPLACEMENT
        )
        .replace(
          CODEX_ACP_TURN_USAGE_START_WITHOUT_COUNT_REPLACEMENT,
          CODEX_ACP_TURN_USAGE_START_REPLACEMENT
        )
  const migratedSource = sourceWithCurrentStart
    .replace(
      CODEX_ACP_TURN_USAGE_UPDATE_LEGACY_WITH_CALLS_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT
    )
    .replace(
      CODEX_ACP_TURN_USAGE_UPDATE_WITH_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT
    )
    .replace(
      CODEX_ACP_TURN_USAGE_UPDATE_WITHOUT_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT
    )
    .replace(
      CODEX_ACP_TURN_USAGE_UPDATE_LEGACY_WITH_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT
    )
    .replaceAll(
      CODEX_ACP_TURN_USAGE_META_WITH_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_META_REPLACEMENT
    )
    .replaceAll(
      CODEX_ACP_TURN_USAGE_META_WITHOUT_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_META_REPLACEMENT
    )
    .replace(
      CODEX_ACP_TURN_USAGE_FINISH_WITH_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_FINISH_REPLACEMENT
    )
    .replace(
      CODEX_ACP_TURN_USAGE_FINISH_WITHOUT_COUNT_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_FINISH_REPLACEMENT
    )
    .replace(
      CODEX_ACP_TURN_USAGE_UPDATE_LEGACY_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT
    )
    .replaceAll(
      CODEX_ACP_TURN_USAGE_RESPONSE_LEGACY_REPLACEMENT,
      CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT
    )
    .replaceAll(CODEX_ACP_TURN_USAGE_META_SOURCE, CODEX_ACP_TURN_USAGE_META_REPLACEMENT)

  if (
    migratedSource.includes(CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT) &&
    migratedSource.includes(CODEX_ACP_TURN_USAGE_START_REPLACEMENT) &&
    migratedSource.includes(CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT) &&
    migratedSource.includes(CODEX_ACP_TURN_USAGE_META_REPLACEMENT) &&
    migratedSource.includes(CODEX_ACP_TURN_USAGE_FINISH_REPLACEMENT)
  ) {
    return migratedSource
  }

  const updateMatches = migratedSource.split(CODEX_ACP_TURN_USAGE_UPDATE_SOURCE).length - 1
  const startMatches = migratedSource.split(CODEX_ACP_TURN_USAGE_START_SOURCE).length - 1
  const responseMatches = migratedSource.split(CODEX_ACP_TURN_USAGE_RESPONSE_SOURCE).length - 1
  const metaMatches = migratedSource.split(CODEX_ACP_TURN_USAGE_META_REPLACEMENT).length - 1
  const finishMatches = migratedSource.split(CODEX_ACP_TURN_USAGE_FINISH_SOURCE).length - 1

  // 1.1.4 has three PromptResponse usage sites. 1.6.2 adds a fourth in
  // terminalFailurePromptResponse; that site spreads quota _meta rather than
  // assigning `buildQuotaMeta` directly, so the meta count stays three.
  if (
    updateMatches === 1 &&
    startMatches === 1 &&
    (responseMatches === 3 || responseMatches === 4) &&
    metaMatches === 3 &&
    finishMatches === 1
  ) {
    return migratedSource
      .replace(CODEX_ACP_TURN_USAGE_UPDATE_SOURCE, CODEX_ACP_TURN_USAGE_UPDATE_REPLACEMENT)
      .replace(CODEX_ACP_TURN_USAGE_START_SOURCE, CODEX_ACP_TURN_USAGE_START_REPLACEMENT)
      .replaceAll(CODEX_ACP_TURN_USAGE_RESPONSE_SOURCE, CODEX_ACP_TURN_USAGE_RESPONSE_REPLACEMENT)
      .replace(CODEX_ACP_TURN_USAGE_FINISH_SOURCE, CODEX_ACP_TURN_USAGE_FINISH_REPLACEMENT)
  }

  if (responseMatches > 0 || migratedSource.includes('buildPromptUsage(lastTokenUsage)')) {
    throw new Error('Pinned Codex ACP turn-usage patch no longer matches the adapter bundle')
  }

  // Unit-test fixtures use tiny stand-in adapters rather than the pinned production bundle.
  return migratedSource
}

// The pinned adapter normally flattens every ACP text block into a Codex text input, discarding
// private extension metadata. Extend that exact source shape so an explicit app Skill selection
// becomes Codex's native UserInput::Skill while preserving the original text byte-for-byte.
export const patchCodexAcpSkillInputSource = (source: string): string => {
  if (source.includes(CODEX_ACP_SKILL_INPUT_REPLACEMENT)) return source

  const matches = source.split(CODEX_ACP_SKILL_INPUT_SOURCE).length - 1
  if (matches === 1) {
    return source.replace(CODEX_ACP_SKILL_INPUT_SOURCE, CODEX_ACP_SKILL_INPUT_REPLACEMENT)
  }

  throw new Error('Pinned Codex ACP Skill-input patch no longer matches the adapter bundle')
}

// Codex builds its ModelsManager once when app-server starts. The adapter otherwise forwards
// CODEX_CONFIG only in thread/start, which is too late for a generated model catalog to participate
// in model lookup. Project just that immutable catalog path into this native process's CLI override;
// the remaining request-scoped config continues through codex-acp unchanged.
export const patchCodexAcpModelCatalogStartupSource = (source: string): string => {
  if (source.includes(CODEX_ACP_MODEL_CATALOG_STARTUP_REPLACEMENT)) return source

  const matches = source.split(CODEX_ACP_MODEL_CATALOG_STARTUP_SOURCE).length - 1
  if (matches === 1) {
    return source.replace(
      CODEX_ACP_MODEL_CATALOG_STARTUP_SOURCE,
      CODEX_ACP_MODEL_CATALOG_STARTUP_REPLACEMENT
    )
  }

  throw new Error(
    'Pinned Codex ACP model-catalog startup patch no longer matches the adapter bundle'
  )
}

export const ensureManagedCodexContextUsage = async (adapterPath: string): Promise<void> => {
  const source = await readFile(adapterPath, 'utf8')
  const patched = patchCodexAcpModelCatalogStartupSource(
    patchCodexAcpSkillInputSource(
      patchCodexAcpTurnUsageSource(patchCodexAcpContextUsageSource(source))
    )
  )

  if (patched === source) return

  const temporaryPath = `${adapterPath}.${randomUUID()}.tmp`
  try {
    const { mode } = await stat(adapterPath)
    await writeFile(temporaryPath, patched)
    await chmod(temporaryPath, mode & 0o7777)
    await renameWithTransientLockRetry(temporaryPath, adapterPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

type PackageResolution = { tarball: string; integrity: string }

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const resolvePinnedPackage = async (
  registry: string,
  encodedName: string,
  version: string,
  expectedIntegrity: string,
  fetchJson: FetchJson,
  signal?: AbortSignal
): Promise<PackageResolution> => {
  const metadata = asRecord(await fetchJson(`${registry}/${encodedName}/${version}`, signal))
  const dist = asRecord(metadata.dist)
  const tarball = dist.tarball
  const integrity = dist.integrity

  if (
    typeof tarball !== 'string' ||
    typeof integrity !== 'string' ||
    !integrity.startsWith('sha512-')
  ) {
    throw new Error(`Incomplete registry metadata for ${encodedName}@${version}`)
  }

  if (integrity !== expectedIntegrity) {
    throw new Error(
      `Registry integrity for ${encodedName}@${version} did not match the pinned manifest`
    )
  }

  return { tarball, integrity: expectedIntegrity }
}

const TAR_BLOCK = 512

const readTarText = (header: Buffer, start: number, end: number): string => {
  const field = header.subarray(start, end)
  const nul = field.indexOf(0)
  return field.toString('utf8', 0, nul === -1 ? field.length : nul)
}

const readTarName = (header: Buffer): string => {
  const name = readTarText(header, 0, 100)
  const prefix = readTarText(header, 345, 500)
  return prefix ? `${prefix}/${name}` : name
}

const readTarOctal = (header: Buffer, start: number, end: number): number => {
  const raw = header.toString('utf8', start, end).replace(/\0/g, '').trim()
  return raw ? Number.parseInt(raw, 8) : 0
}

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0)

const writeAll = async (file: FileHandle, data: Buffer): Promise<void> => {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset)
    if (bytesWritten === 0) throw new Error('Could not write extracted Codex resource')
    offset += bytesWritten
  }
}

class TarSubtreeExtractor extends Writable {
  private leftover = Buffer.alloc(0)
  private state: 'header' | 'body' = 'header'
  private remaining = 0
  private padding = 0
  private currentFile: FileHandle | undefined
  private currentPath: string | undefined
  private currentMode = 0o644
  private entries = 0

  constructor(
    private readonly archivePrefix: string,
    private readonly destination: string
  ) {
    super()
  }

  foundEntries(): boolean {
    return this.entries > 0
  }

  async _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): Promise<void> {
    try {
      this.leftover = Buffer.concat([this.leftover, chunk])
      await this.consume()
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.currentFile) {
      callback(error)
      return
    }

    this.currentFile.close().then(() => callback(error), callback)
  }

  private outputPath(entryName: string): string | undefined {
    const normalized = posix.normalize(entryName)
    const prefix = this.archivePrefix.endsWith('/')
      ? this.archivePrefix.slice(0, -1)
      : this.archivePrefix

    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) return undefined
    if (!normalized.startsWith('package/')) {
      throw new Error(`Unsafe Codex archive path: ${entryName}`)
    }

    const relative = normalized.slice('package/'.length)
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('../') ||
      posix.isAbsolute(relative)
    ) {
      throw new Error(`Unsafe Codex archive path: ${entryName}`)
    }

    const output = resolve(this.destination, ...relative.split('/'))
    const root = resolve(this.destination)
    if (output !== root && !output.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe Codex archive path: ${entryName}`)
    }

    return output
  }

  private async beginEntry(header: Buffer): Promise<void> {
    const name = readTarName(header)
    const output = this.outputPath(name)
    const type = String.fromCharCode(header[156] ?? 0)
    this.remaining = readTarOctal(header, 124, 136)
    this.padding = (TAR_BLOCK - (this.remaining % TAR_BLOCK)) % TAR_BLOCK
    this.currentMode = readTarOctal(header, 100, 108) || 0o644
    this.currentPath = undefined

    if (!output) return
    if (type === '5') {
      await mkdir(output, { recursive: true })
      this.entries += 1
      return
    }
    if (type !== '0' && type !== '\0') {
      throw new Error(`Unsupported entry type in Codex archive: ${name}`)
    }

    await mkdir(dirname(output), { recursive: true })
    this.currentFile = await open(output, 'w', this.currentMode)
    this.currentPath = output
    this.entries += 1
  }

  private async finishEntry(): Promise<void> {
    const file = this.currentFile
    const output = this.currentPath
    this.currentFile = undefined
    this.currentPath = undefined

    if (file) await file.close()
    if (output && process.platform !== 'win32') await chmod(output, this.currentMode)
  }

  private async consume(): Promise<void> {
    for (;;) {
      if (this.state === 'header') {
        if (this.leftover.length < TAR_BLOCK) return
        const header = this.leftover.subarray(0, TAR_BLOCK)
        this.leftover = this.leftover.subarray(TAR_BLOCK)
        if (isZeroBlock(header)) continue

        await this.beginEntry(header)
        this.state = 'body'
        continue
      }

      if (this.remaining > 0) {
        if (this.leftover.length === 0) return
        const take = Math.min(this.remaining, this.leftover.length)
        const piece = this.leftover.subarray(0, take)
        this.leftover = this.leftover.subarray(take)
        this.remaining -= take
        if (this.currentFile) await writeAll(this.currentFile, piece)
        continue
      }

      if (this.padding > 0) {
        if (this.leftover.length === 0) return
        const take = Math.min(this.padding, this.leftover.length)
        this.leftover = this.leftover.subarray(take)
        this.padding -= take
        continue
      }

      await this.finishEntry()
      this.state = 'header'
    }
  }
}

const extractCodexVendor = async ({
  tgzPath,
  target,
  destination,
  signal
}: {
  tgzPath: string
  target: string
  destination: string
  signal?: AbortSignal
}): Promise<void> => {
  const extractor = new TarSubtreeExtractor(`package/vendor/${target}`, destination)
  await pipeline(createReadStream(tgzPath), createGunzip(), extractor, { signal })
  if (!extractor.foundEntries()) {
    throw new Error(`Codex package did not contain vendor/${target}`)
  }
}

export type ManagedCodexInstallOutcome = {
  result: ClaudeInstallResult
  adapterPath?: string
  adapterVersion?: string
  codexPath?: string
  codexVersion?: string
}

export type VersionVerifier = (path: string, signal?: AbortSignal) => Promise<string | undefined>
export type PairVerifier = (
  adapterPath: string,
  codexPath: string,
  codexHome: string,
  signal?: AbortSignal
) => Promise<void>

export type InstallManagedCodexOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  dataRoot: string
  // When Codex CLI is user-owned, update only the app-controlled adapter and verify it against this
  // existing binary. The caller keeps the user's persisted CLI path/version instead of replacing it.
  existingCodexPath?: string
  registries?: string[]
  platform?: ManagedCodexPlatform
  fetchJson?: FetchJson
  fetchTarball?: FetchTarball
  verifyAdapter?: VersionVerifier
  verifyCodex?: VersionVerifier
  verifyPair?: PairVerifier
  integrities?: { adapter: string; codex: string }
  signal?: AbortSignal
}

const parseVersion = (output: string): string | undefined =>
  output.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0]

export type ManagedCodexVersionSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    encoding: 'utf8'
    timeout: number
    windowsHide: true
    env?: NodeJS.ProcessEnv
    shell?: boolean
    signal?: AbortSignal
  }
) => Promise<{ status: number | null; stdout: string }>

const spawnManagedCodexVersion: ManagedCodexVersionSpawn = async (executable, args, options) => {
  try {
    const { stdout } = await execFileAsync(executable, args, options)
    return { status: 0, stdout }
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: string }
    return {
      status: typeof failure.code === 'number' ? failure.code : null,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : ''
    }
  }
}

export const runManagedCodexVersion = async (
  executable: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  _platform: NodeJS.Platform = process.platform,
  spawnVersion: ManagedCodexVersionSpawn = spawnManagedCodexVersion,
  signal?: AbortSignal
): Promise<string | undefined> => {
  const useShell = _platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const result = await spawnVersion(useShell ? `"${executable}"` : executable, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env,
    signal,
    ...(useShell ? { shell: true } : {})
  })

  return result.status === 0 ? parseVersion(result.stdout) : undefined
}

const defaultVerifyAdapter: VersionVerifier = async (adapterPath, signal) =>
  runManagedCodexVersion(
    process.execPath,
    [adapterPath, '--version'],
    {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NO_BROWSER: '1'
    },
    process.platform,
    undefined,
    signal
  )

const defaultVerifyCodex: VersionVerifier = async (codexPath, signal) =>
  runManagedCodexVersion(
    codexPath,
    ['--version'],
    { ...process.env, NO_BROWSER: '1' },
    process.platform,
    undefined,
    signal
  )

// Keeps adapter stderr useful for troubleshooting while preventing credentials or unbounded child
// output from entering the app log. The installer never logs the child environment or initialize body.
export const sanitizeManagedCodexDiagnostic = (
  value: string
): { text: string; truncated: boolean } => {
  const redacted = value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)[^\s,"']+/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')

  return {
    text: redacted.slice(0, MAX_INITIALIZE_DIAGNOSTIC_CHARS),
    truncated: redacted.length > MAX_INITIALIZE_DIAGNOSTIC_CHARS
  }
}

export const verifyManagedCodexPair: PairVerifier = async (
  adapterPath,
  codexPath,
  codexHome,
  signal
) => {
  signal?.throwIfAborted()
  await mkdir(codexHome, { recursive: true })
  // Force the in-memory credential store so a stray host key can never be persisted into this home
  // during the handshake (defense-in-depth alongside the credential-stripped env below).
  await writeFile(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\n')
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'open-science-installer', version: '0.0.0' }
    }
  })
  const child = spawn(process.execPath, [adapterPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...stripCodexCredentialEnv(process.env),
      ELECTRON_RUN_AS_NODE: '1',
      CODEX_HOME: codexHome,
      CODEX_PATH: codexPath,
      NO_BROWSER: '1'
    }
  })

  let initialized = false
  let stdoutLineCount = 0
  let stdoutBuffer = ''
  let stderrOutput = ''
  let spawnError: Error | undefined

  // Reap the adapter AND its Codex app-server grandchild exactly once. Both the initialize handler (which
  // reaps early, while the parent is still alive so the descendant walk — taskkill /T on Windows, a ps
  // descendant enumeration on POSIX — can still find the grandchild) and the terminal `finish` path funnel
  // through this memoized promise, so we never launch two concurrent teardowns racing on the same child.
  // A degraded reap (taskkill fallback / surviving descendant) is surfaced so a leaked grandchild is not
  // silently swallowed by the smoke check.
  let terminationPromise: ReturnType<typeof terminateProcessTree> | undefined
  const reapTree = (): ReturnType<typeof terminateProcessTree> => {
    terminationPromise ??= terminateProcessTree(child, undefined, log).then((result) => {
      if (!result.reaped) {
        log.warn('ACP initialize check could not confirm the Codex process tree was fully reaped')
      }
      return result
    })
    return terminationPromise
  }

  const consumeStdoutLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    stdoutLineCount += 1

    try {
      const message = JSON.parse(trimmed) as {
        id?: unknown
        result?: { protocolVersion?: unknown }
      }
      if (message.id !== 1) return
      initialized = message.result?.protocolVersion === 1
      // Reap the whole tree NOW, while the adapter parent is still alive, so taskkill /T (Windows) can
      // still find the Codex app-server grandchild through it. Relying on stdin-close → clean adapter
      // exit and killing afterwards can leave a reparented grandchild unreachable by the (dead) PID.
      void reapTree()
    } catch {
      // Non-JSON stdout is counted for diagnostics but is not a valid ACP initialize response.
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      consumeStdoutLine(stdoutBuffer.slice(0, newline))
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderrOutput.length < MAX_INITIALIZE_DIAGNOSTIC_CHARS * 2) {
      stderrOutput += chunk.slice(0, MAX_INITIALIZE_DIAGNOSTIC_CHARS * 2 - stderrOutput.length)
    }
  })

  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolveResult) => {
      let settled = false
      const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        abortSignal?.removeEventListener('abort', abortInstall)
        if (stdoutBuffer.trim()) consumeStdoutLine(stdoutBuffer)
        // Reap the adapter AND its Codex app-server grandchild on every terminal path (success, error,
        // timeout), awaiting the SAME memoized teardown before resolving. On timeout the parent is still
        // alive here; on success consumeStdoutLine already started the one reap this awaits.
        void reapTree().finally(() => resolveResult({ status, signal }))
      }
      const abortSignal = signal
      const abortInstall = (): void => {
        spawnError =
          abortSignal?.reason instanceof Error
            ? abortSignal.reason
            : new Error('Codex install cancelled')
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(child.exitCode, child.signalCode)
      }
      const timeout = setTimeout(() => {
        spawnError = new Error('ACP initialize check timed out after 15000ms')
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(child.exitCode, child.signalCode)
      }, 15_000)
      abortSignal?.addEventListener('abort', abortInstall, { once: true })
      if (abortSignal?.aborted) abortInstall()

      child.once('error', (error) => {
        spawnError = error
        finish(child.exitCode, child.signalCode)
      })
      child.once('exit', finish)
      child.stdin.write(`${initialize}\n`, (error) => {
        if (!error) return
        spawnError = error
        finish(child.exitCode, child.signalCode)
      })
    }
  )

  // Success is judged by the initialize handshake alone: we force-kill the tree (see above), so the
  // child's exit status/signal now reflect the kill, not a failure. spawnError also covers the timeout.
  if (spawnError || !initialized) {
    const stderr = sanitizeManagedCodexDiagnostic(stderrOutput)
    const safeSpawnError = spawnError
      ? sanitizeManagedCodexDiagnostic(spawnError.message)
      : undefined
    log.error('ACP initialize check failed', {
      status: result.status,
      signal: result.signal,
      initialized,
      stdoutLineCount,
      stderr: stderr.text,
      stderrTruncated: stderr.truncated,
      spawnError: safeSpawnError
        ? {
            name: spawnError?.name,
            code: errorCode(spawnError),
            message: safeSpawnError.text,
            truncated: safeSpawnError.truncated
          }
        : undefined
    })
    throw new Error('Installed Codex runtime failed its ACP initialize check')
  }
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

// Move the backup back into place after a failed install step, then rethrow the original cause.
// When even the restore fails, the previous install survives only at the random backup path —
// log it and annotate the error so the caller can surface where to recover it manually.
const restoreBackupOrThrow = async (
  backup: string,
  destination: string,
  cause: unknown
): Promise<never> => {
  try {
    await rename(backup, destination)
  } catch (restoreError) {
    log.error(`Failed to restore backup. Backup retained at: ${backup}`, restoreError)
    const msg = toErrorMessage(cause)
    throw new Error(`${msg} (backup retained at ${backup})`)
  }
  throw cause
}

const replaceDirectory = async (staged: string, destination: string): Promise<void> => {
  const backup = `${destination}.backup-${randomUUID()}`
  let hasBackup = false

  // Step 1: move the existing destination aside as a backup.
  // On Windows, rename can fail with EPERM when antivirus holds a lock on files inside the
  // existing install, or EXDEV on a cross-device move (defensive — same-volume layout makes
  // EXDEV unreachable in practice, but guarded for completeness). Fall back to cp+rm.
  try {
    await rename(destination, backup)
    hasBackup = true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') {
      // Nothing to back up — first install.
    } else if (code === 'EPERM' || code === 'EXDEV') {
      try {
        await cp(destination, backup, { recursive: true })
        await rm(destination, { recursive: true, force: true })
        hasBackup = true
      } catch (fallbackError) {
        // The backup fallback failed partway: the existing install may be partially deleted and
        // the backup may be incomplete. Surface the real cause (not the original EPERM) plus
        // the backup path so the user can recover manually.
        log.error(
          `Failed to back up existing install before replacement. Backup may be incomplete at: ${backup}`,
          fallbackError
        )
        const msg = toErrorMessage(fallbackError)
        throw new Error(`${msg} (backup may be incomplete at ${backup})`)
      }
    } else {
      throw error
    }
  }

  // Step 2: move the staged runtime into the final destination.
  try {
    await rename(staged, destination)
  } catch (renameError) {
    const code = errorCode(renameError)
    if (code === 'EPERM' || code === 'EXDEV') {
      try {
        await cp(staged, destination, { recursive: true })
        await rm(staged, { recursive: true, force: true }).catch(() => undefined)
      } catch (copyError) {
        // Copy failed — try to restore the backup so the user's previous install survives.
        await rm(destination, { recursive: true, force: true }).catch(() => undefined)
        if (hasBackup) await restoreBackupOrThrow(backup, destination, copyError)
        throw copyError
      }
    } else {
      if (hasBackup) await restoreBackupOrThrow(backup, destination, renameError)
      throw renameError
    }
  }

  if (hasBackup) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
}

export const installManagedCodex = async (
  options: InstallManagedCodexOptions
): Promise<ManagedCodexInstallOutcome> => {
  const {
    installId,
    onEvent,
    dataRoot,
    registries = DEFAULT_REGISTRIES,
    platform = resolveManagedCodexPlatform(),
    fetchJson = defaultFetchJson,
    fetchTarball = defaultFetchTarball,
    verifyAdapter = defaultVerifyAdapter,
    verifyCodex = defaultVerifyCodex,
    verifyPair = verifyManagedCodexPair,
    existingCodexPath,
    signal,
    integrities = {
      adapter: CODEX_ACP_INTEGRITY,
      codex: CODEX_INTEGRITIES[platform.key] ?? ''
    }
  } = options
  if (!existingCodexPath && !integrities.codex) {
    return {
      result: { installId, ok: false, error: `No pinned Codex integrity for ${platform.key}` }
    }
  }

  await mkdir(dataRoot, { recursive: true })
  let lastError = 'no registries configured'

  for (const registry of registries) {
    const scratch = await mkdtemp(join(dataRoot, '.codex-install-'))
    const stagedRoot = join(scratch, 'runtime')
    const adapterTgz = join(scratch, 'adapter.tgz')
    const codexTgz = join(scratch, 'codex.tgz')

    // Tracks whether the install has left the registry-dependent phase: the staged bits are
    // byte-identical across registries (pinned versions + integrities), so a replaceDirectory
    // failure is a deterministic local filesystem error — retrying the next registry would
    // re-download the same bits into the same error and overwrite the backup path it carries.
    let reachedLocalInstall = false
    try {
      onEvent({ kind: 'progress', installId, phase: 'resolving' })
      const adapter = await resolvePinnedPackage(
        registry,
        '@agentclientprotocol%2fcodex-acp',
        CODEX_ACP_VERSION,
        integrities.adapter,
        fetchJson,
        signal
      )
      const codex = existingCodexPath
        ? undefined
        : await resolvePinnedPackage(
            registry,
            '@openai%2fcodex',
            `${CODEX_VERSION}-${platform.key}`,
            integrities.codex,
            fetchJson,
            signal
          )

      await downloadAndVerify({
        url: adapter.tarball,
        integrity: adapter.integrity,
        destPath: adapterTgz,
        installId,
        onEvent,
        fetchTarball,
        signal
      })
      if (codex) {
        await downloadAndVerify({
          url: codex.tarball,
          integrity: codex.integrity,
          destPath: codexTgz,
          installId,
          onEvent,
          fetchTarball,
          signal
        })
      }

      onEvent({ kind: 'progress', installId, phase: 'extracting' })
      const stagedAdapter = adapterEntryInRoot(stagedRoot)
      const foundAdapter = await extractFileFromTgz({
        tgzPath: adapterTgz,
        entryName: 'package/dist/index.js',
        destPath: stagedAdapter,
        signal
      })
      if (!foundAdapter) throw new Error('Codex ACP package did not contain dist/index.js')
      await ensureManagedCodexContextUsage(stagedAdapter)

      if (codex) {
        await extractCodexVendor({
          tgzPath: codexTgz,
          target: platform.target,
          destination: join(stagedRoot, 'codex'),
          signal
        })
      }
      const codexPath = existingCodexPath ?? codexBinaryInRoot(stagedRoot, platform)
      if (process.platform !== 'win32') {
        await chmod(stagedAdapter, 0o755)
        if (!existingCodexPath) await chmod(codexPath, 0o755)
      }

      onEvent({ kind: 'progress', installId, phase: 'installing' })
      signal?.throwIfAborted()
      const adapterVersion = await verifyAdapter(stagedAdapter, signal)
      signal?.throwIfAborted()
      if (!adapterVersion) throw new Error('Installed Codex ACP adapter failed its --version check')
      let codexVersion: string
      try {
        const verifiedVersion = await verifyCodex(codexPath, signal)
        signal?.throwIfAborted()
        if (!verifiedVersion) throw new Error('Installed Codex binary failed its --version check')
        // Smoke home lives in scratch (auto-removed), NEVER inside stagedRoot: stagedRoot is moved to
        // the final runtime, so anything Codex might write here must not ride along into the install.
        const smokeHome = join(scratch, 'smoke-home')
        if (signal) await verifyPair(stagedAdapter, codexPath, smokeHome, signal)
        else await verifyPair(stagedAdapter, codexPath, smokeHome)
        codexVersion = verifiedVersion
      } catch (error) {
        signal?.throwIfAborted()
        if (!existingCodexPath) throw error
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: `Existing Codex CLI is incompatible with the managed adapter; falling back to the managed Codex CLI.\n`
        })
        return installManagedCodex({ ...options, existingCodexPath: undefined })
      }

      signal?.throwIfAborted()
      reachedLocalInstall = true
      if (existingCodexPath) {
        await mkdir(managedCodexRoot(dataRoot), { recursive: true })
        await replaceDirectory(
          join(stagedRoot, 'adapter'),
          join(managedCodexRoot(dataRoot), 'adapter')
        )
      } else {
        await replaceDirectory(stagedRoot, managedCodexRoot(dataRoot))
      }

      return {
        result: { installId, ok: true },
        adapterPath: managedCodexAdapterEntry(dataRoot),
        adapterVersion,
        codexPath: existingCodexPath ?? managedCodexBinary(dataRoot, platform),
        codexVersion
      }
    } catch (error) {
      lastError = toErrorMessage(error)
      if (signal?.aborted) return { result: { installId, ok: false, error: lastError } }
      if (reachedLocalInstall) {
        // Local install failure — do not attribute it to the registry or try the next one.
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: `install failed: ${lastError}\n`
        })
        return { result: { installId, ok: false, error: lastError } }
      }
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `${registry} failed: ${lastError}\n`
      })
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { result: { installId, ok: false, error: lastError } }
}

// Backups are always directories named `codex-managed.backup-<uuid>` (see replaceDirectory) —
// match that exact shape so uninstall never deletes look-alike entries sharing the prefix.
const ORPHANED_BACKUP_PATTERN =
  /^codex-managed\.backup-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export const uninstallManagedCodex = async (dataRoot: string): Promise<void> => {
  await rm(managedCodexRoot(dataRoot), { recursive: true, force: true }).catch(() => undefined)
  // Failed installs can leave orphaned backups behind (retained for manual recovery) —
  // uninstall removes them along with the managed tree.
  const entries = await readdir(dataRoot, { withFileTypes: true }).catch(() => [] as Dirent[])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && ORPHANED_BACKUP_PATTERN.test(entry.name))
      .map((entry) =>
        rm(join(dataRoot, entry.name), { recursive: true, force: true }).catch(() => undefined)
      )
  )
}
