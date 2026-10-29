#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- This bootstrap runs directly in Node. */
// Build the application-owned ACP entry from a pinned upstream bundle; never modify node_modules.
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))
if (process.argv.length !== 4) throw new Error('Usage: node bootstrap.mjs package-dir output-dir')
const source = resolve(process.argv[2])
const destination = resolve(process.argv[3])

const expectedBundle = 'f4c2b485e9a9cac894149366c362b6c7625aaeaa5fe04e5fb9c6b761afee4f79'
const expectedBin = '066e83d7f9b4ccbd475691af05a5be365aec0927574769dcacd21e22abe49382'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const packageJson = await readFile(join(source, 'package.json'))
const pkg = JSON.parse(packageJson)
if (pkg.name !== '@openma/pi-acp' || pkg.version !== '0.1.8')
  throw new Error('Unexpected Pi ACP package')
const binary = await readFile(join(source, 'dist/bin.js'))
const original = await readFile(join(source, 'dist/chunk-5IXHVFXW.js'), 'utf8')
if (sha256(binary) !== expectedBin || sha256(original) !== expectedBundle) {
  throw new Error('Pi ACP bundle does not match the pinned package')
}
const guard = await readFile(join(projectRoot, 'permission-guard.mjs'))
const license = await readFile(join(source, 'LICENSE'))

function replaceOne(input, before, after) {
  const index = input.indexOf(before)
  if (index < 0 || input.indexOf(before, index + before.length) >= 0) {
    throw new Error('Expected Pi ACP patch point is missing or ambiguous')
  }
  return input.slice(0, index) + after + input.slice(index + before.length)
}

let bundle = `import { createPermissionGuard, GUARD_NAME } from './permission-guard.mjs';
import { VERSION as openSciencePiVersion } from '@earendil-works/pi-coding-agent';
if (openSciencePiVersion !== '1.4.0') throw new Error('Unsupported Pi SDK version; session refused');
${original}`
bundle = replaceOne(
  bundle,
  '        resourceLoaderOptions: {\n          eventBus: this.eventBus,',
  '        resourceLoaderOptions: {\n          noExtensions: true,\n          noSkills: true,\n          noPromptTemplates: true,\n          noContextFiles: true,\n          eventBus: this.eventBus,'
)
bundle = replaceOne(
  bundle,
  '            ...mcp.servers.length > 0 ? [...piMcpExtensions(dir), mcp.extension] : []\n          ]',
  `            ...mcp.servers.length > 0 ? [...piMcpExtensions(dir), mcp.extension] : [],
            createPermissionGuard({
              conn: this.conn,
              sessionId: this._sessionId,
              flush: () => this.flush(),
              getDefinition: (name) => this.session.getToolDefinition(name),
              serverNames: mcp.servers.map((server) => server.name)
            })
          ]`
)
bundle = replaceOne(
  bundle,
  '      const customTools = [];\n      if (settings.delegation) {',
  `      const extensions = services.resourceLoader.getExtensions();
      const guardPath = \`<inline:\${GUARD_NAME}>\`;
      if (extensions.extensions.at(-1)?.path !== guardPath ||
          extensions.errors.some((error) => error.path === guardPath)) {
        throw new Error('Pi permission guard failed to load last; session refused');
      }
      const customTools = [];
      if (false) {`
)
bundle = replaceOne(
  bundle,
  '        customTools,\n        ...model !== void 0',
  '        customTools,\n        noTools: "builtin",\n        excludeTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"],\n        ...model !== void 0'
)
bundle = replaceOne(
  bundle,
  '    const slash = converted.images.length === 0 ? parseSlashCommand(converted.text) : void 0;',
  `    const slash = converted.images.length === 0 ? parseSlashCommand(converted.text) : void 0;
    if (parseSlashCommand(converted.text) !== void 0) {
      session.text('Slash commands are unavailable in the Open Science Pi adapter.');
      await session.flush();
      return { stopReason: 'end_turn' };
    }`
)
bundle = replaceOne(
  bundle,
  `  async storeApiKey(modelRuntime, provider, apiKey) {
    try {
      await modelRuntime.login(provider, "api_key", {
        prompt: async () => apiKey,
        notify: (event) => logDebug(\`login[\${provider}] \${event.type}\`)
      });
    } catch (error) {
      logWarn(
        \`persisting API key for \${provider} failed (\${errorMessage(error)}); using it for this process only\`
      );
      await modelRuntime.setRuntimeApiKey(provider, apiKey);
      this.runtimeKeys.add(provider);
    }
  }`,
  `  async storeApiKey(modelRuntime, provider, apiKey) {
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
    this.runtimeKeys.add(provider);
  }`
)
bundle = replaceOne(
  bundle,
  '  async runAuthenticate(params) {\n    const modelRuntime = await this.modelRuntime();',
  `  async runAuthenticate(params) {
    if (params.methodId !== 'api-key:open-science') throw invalidParams('Unsupported Pi authentication method');
    const modelRuntime = await this.modelRuntime();`
)

const files = new Map([
  ['package.json', packageJson],
  ['LICENSE', license],
  ['dist/bin.js', binary],
  ['dist/chunk-5IXHVFXW.js', Buffer.from(bundle)],
  ['dist/permission-guard.mjs', guard]
])
let exists = false
try {
  await lstat(destination)
  exists = true
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (exists) {
  for (const [name, content] of files) {
    const existing = await readFile(join(destination, name)).catch(() => undefined)
    if (!existing || !existing.equals(content)) throw new Error(`Pi ACP output differs: ${name}`)
  }
} else {
  await mkdir(join(destination, 'dist'), { recursive: true })
  for (const [name, content] of files)
    await writeFile(join(destination, name), content, { flag: 'wx' })
}
console.log(`Prepared app-owned Pi ACP at ${destination}`)
