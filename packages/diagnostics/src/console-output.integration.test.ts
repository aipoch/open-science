import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterAll, beforeAll, expect, it } from 'vitest'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'diagnostics-console-output-'))
  // Run the source implementation in ordinary child processes so stream errors cannot affect
  // Vitest's own output. Use this package's declared compiler, without relying on a stale dist/.
  for (const name of await readdir(new URL('.', import.meta.url))) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const source = await readFile(new URL(name, import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    await writeFile(join(root, name.replace(/\.ts$/, '.js')), compiled.outputText)
  }
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const scenarios = (['stdout', 'stderr'] as const).flatMap((stream) =>
  (['EIO', 'EPIPE'] as const).flatMap((code) =>
    (['sync', 'async', 'throw', 'public-throw'] as const).map((timing) => ({
      stream,
      code,
      timing
    }))
  )
)

it.each(scenarios)('keeps file logging and shutdown alive with %j', async (scenario) => {
  const logDir = join(root, `${scenario.stream}-${scenario.code}-${scenario.timing}`)
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const { Console } = require('node:console');
      // A host-supplied console is allowed to propagate errors. The logger must own the
      // failure policy of its optional console mirror rather than rely on that host policy.
      global.console = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
      const { initLogger, createLogger, flushLogs } = require(${JSON.stringify(join(root, 'logger.js'))});
      const scenario = ${JSON.stringify(scenario)};
      const output = process[scenario.stream];
      const write = output.write;
      let writes = 0;
      output.write = function (...args) {
        writes++;
        if (scenario.timing === 'public-throw') {
          throw Object.assign(new Error('write ' + scenario.code), { code: scenario.code });
        }
        return write.apply(this, args);
      };
      output._write = (_chunk, _encoding, callback) => {
        const error = Object.assign(new Error('write ' + scenario.code), { code: scenario.code });
        if (scenario.timing === 'throw') throw error;
        if (scenario.timing === 'async') setImmediate(() => callback(error));
        else callback(error);
      };
      initLogger({ logDir: ${JSON.stringify(logDir)}, mirrorToConsole: true });
      (async () => {
        const log = createLogger('shutdown');
        log.info('preflight');
        log.warn('drain');
        await new Promise(setImmediate);
        await new Promise(setImmediate);
        log.info('flush');
        log.error('teardown');
        const flushed = await flushLogs();
        if (flushed.failed) throw new Error('File sink failed');
        require('node:fs').writeFileSync(${JSON.stringify(join(logDir, 'writes.json'))}, JSON.stringify({ writes }));
        require('node:fs').writeFileSync(${JSON.stringify(join(logDir, 'completed'))}, 'shutdown completed');
      })().catch(() => { process.exitCode = 2 });
    `
    ],
    { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(await readFile(join(logDir, 'completed'), 'utf8')).toBe('shutdown completed')
  expect(JSON.parse(await readFile(join(logDir, 'writes.json'), 'utf8'))).toEqual({ writes: 1 })
  const records = (await readFile(join(logDir, 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.msg)).toEqual(['preflight', 'drain', 'flush', 'teardown'])
  const healthyOutput = scenario.stream === 'stdout' ? result.stderr : result.stdout
  const healthyMessages =
    scenario.stream === 'stdout' ? ['drain', 'teardown'] : ['preflight', 'flush']
  for (const message of healthyMessages) expect(healthyOutput).toContain('[shutdown] ' + message)
})

it('does not suppress an unrelated uncaught application error', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { initLogger, createLogger } = require(${JSON.stringify(join(root, 'logger.js'))});
    initLogger({ logDir: ${JSON.stringify(join(root, 'fatal'))}, mirrorToConsole: true });
    createLogger('shutdown').info('before unrelated failure');
    setImmediate(() => { throw new Error('unrelated application failure'); });
  `
    ],
    { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('unrelated application failure')
})

it.each(['text', 'json'] as const)(
  'preserves redacted inspector events in %s mode when terminal output fails',
  async (consoleFormat) => {
    const logDir = join(root, `inspector-${consoleFormat}`)
    const eventsPath = join(root, `inspector-${consoleFormat}.json`)
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
        const { Session } = require('node:inspector');
        const { initLogger, createLogger, flushLogs } = require(${JSON.stringify(join(root, 'logger.js'))});
        const session = new Session();
        const events = [];
        session.connect();
        session.on('Runtime.consoleAPICalled', ({ params }) => {
          events.push({ type: params.type, message: params.args[0]?.value });
        });
        session.post('Runtime.enable', async error => {
          if (error) { process.exitCode = 2; return; }
          try {
            const options = { logDir: ${JSON.stringify(logDir)}, consoleFormat: ${JSON.stringify(consoleFormat)} };
            initLogger({ ...options, mirrorToConsole: true });
            const log = createLogger('inspector-check');
            for (const phase of ['healthy', 'failed']) {
              if (phase === 'failed') {
                for (const output of [process.stdout, process.stderr]) {
                  output.write = () => { throw Object.assign(new Error('write EIO'), { code: 'EIO' }); };
                }
              }
              for (const level of ['debug', 'info', 'warn', 'error']) {
                log[level](phase + ' ' + level + ' apiKey=fictional-inspector-secret');
              }
            }
            await flushLogs();
            initLogger({ ...options, mirrorToConsole: false });
            log.info('file only');
            await flushLogs();
            require('node:fs').writeFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(events));
          } catch { process.exitCode = 2; }
          finally { session.disconnect(); }
        });
      `
      ],
      { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const events: { type: string; message: string }[] = JSON.parse(
      await readFile(eventsPath, 'utf8')
    )
    expect(events.map((event) => event.type)).toEqual([
      'log',
      'info',
      'warning',
      'error',
      'log',
      'info',
      'warning',
      'error'
    ])
    const records = (await readFile(join(logDir, 'main.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(9)
    expect(events.map((event) => event.message)).toEqual(
      records
        .slice(0, 8)
        .map((record) =>
          consoleFormat === 'json' ? JSON.stringify(record) : `[${record.scope}] ${record.msg}`
        )
    )
    expect(JSON.stringify(events)).not.toContain('fictional-inspector-secret')
    expect(records.at(-1).msg).toBe('file only')
  }
)
