import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { buildLocalTranslationWorker, createBackendBuilder } from './build-backend.mjs'
import { desktopBackendDependencies } from './backend-dependencies.mjs'

it('isolates desktop bundles from CLI output and runs all native locales and workers without external i18next', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-backend-build-'))
  const put = async (file: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('i18next/package.json'))
  try {
    for (const file of [
      'packages/open-science/installation-startup.cjs',
      'src/shared/i18n/core.ts',
      'src/shared/locale.ts'
    ])
      await put(file, await readFile(join(process.cwd(), file), 'utf8'))
    await cp(
      join(process.cwd(), 'src/shared/i18n/locales'),
      join(root, 'src/shared/i18n/locales'),
      { recursive: true }
    )
    await cp(packageRoot, join(root, 'node_modules/i18next'), { recursive: true })
    const dependencies = { i18next: '25.10.10' }
    await put('package.json', JSON.stringify({ dependencies }))
    await put(
      'src/main/node-entry.ts',
      `
      export * from '../shared/i18n/core';
      export { default as worker } from './locale-worker?nodeWorker';
    `
    )
    await put(
      'src/main/locale-worker.ts',
      `
      import { parentPort } from 'node:worker_threads';
      import { createI18nInstance, initializeI18nInstance } from '../shared/i18n/core';
      const instance = initializeI18nInstance(createI18nInstance(), {
        locale: 'de', namespaces: ['native'], defaultNamespace: 'native',
        resources: { de: { native: { 'Worker ready': 'Bereit' } } }
      });
      parentPort.postMessage(instance.t('Worker ready'));
    `
    )
    for (const desktop of [false, true]) {
      const builder = await createBackendBuilder({ root, desktop })
      try {
        expect(await builder.rebuild()).toBe(1)
      } finally {
        await builder.dispose()
      }
    }
    const cli = await readFile(join(root, 'out/backend/index.cjs'), 'utf8')
    const metadata = JSON.parse(
      await readFile(join(root, 'out/desktop-backend-build/dependencies.json'), 'utf8')
    )
    expect(desktopBackendDependencies(dependencies, metadata)).toEqual([])
    expect(
      await readFile(
        join(root, 'out/desktop-backend-build/third-party-licenses/i18next-LICENSE'),
        'utf8'
      )
    ).toBe(await readFile(join(packageRoot, 'LICENSE'), 'utf8'))
    await put(
      'compare.cjs',
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { registerHooks } = require('node:module');
      const baseline = require('./out/backend/index.cjs');
      registerHooks({ resolve(name, context, next) {
        if (name === 'i18next' || name.startsWith('i18next/') || name.startsWith('@babel/runtime'))
          throw new Error('External translation dependency requested');
        return next(name, context);
      } });
      assert.throws(() => require('i18next'), /External translation dependency/);
      const bundled = require('./out/desktop-backend-build/index.cjs');
      let comparisons = 0;
      for (const locale of ['en','de','es','fr','ja','ko','ru','zh-Hans','zh-Hant']) {
        const catalog = locale === 'en' ? { common: {}, native: {} } : JSON.parse(fs.readFileSync(path.join(__dirname, 'out/desktop-backend-build/native-locales', locale + '.json')));
        assert.equal(catalog.renderer, undefined);
        const options = { locale, namespaces: ['common','native'], defaultNamespace: 'native', fallbackNamespaces: ['common'], resources: { [locale]: catalog } };
        const a = baseline.initializeI18nInstance(baseline.createI18nInstance(), structuredClone(options));
        const b = bundled.initializeI18nInstance(bundled.createI18nInstance(), structuredClone(options));
        for (const ns of ['common','native']) for (const key of [...Object.keys(catalog[ns]), 'Missing {{name}}', '{{count}} files']) for (const count of [0,1,2,5,21,1000000]) {
          const args = { ns, count, name: 'Synthetic', defaultValue_one: '1 file' };
          assert.equal(b.t(key, args), a.t(key, args), locale + ':' + key);
          comparisons++;
        }
      }
      console.log('COMPARISON_RESULT=' + JSON.stringify({ comparisons }));
    `
    )
    const options = {
      cwd: root,
      encoding: 'utf8' as const,
      timeout: 15_000,
      env: {
        ...process.env,
        OPEN_SCIENCE_CONFIG_ROOT: join(root, 'config'),
        OPEN_SCIENCE_INSTALLATION_STATE_ROOT: join(root, 'installation-state')
      }
    }
    const comparisonOutput = execFileSync(process.execPath, [join(root, 'compare.cjs')], options)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('COMPARISON_RESULT='))
    expect(comparisonOutput).toHaveLength(1)
    expect(
      JSON.parse(comparisonOutput[0].slice('COMPARISON_RESULT='.length)).comparisons
    ).toBeGreaterThan(7000)
    // Physical removal also covers the separate worker process; it cannot borrow the test runner's copy.
    await rename(join(root, 'node_modules/i18next'), join(root, 'parked-i18next'))
    await put(
      'worker.cjs',
      `
      require('./out/desktop-backend-build/index.cjs').worker().once('message', (value) => {
        require('node:assert/strict').equal(value, 'Bereit'); console.log(value);
      });
    `
    )
    expect(
      execFileSync(process.execPath, [join(root, 'worker.cjs')], options)
        .trim()
        .split(/\r?\n/)
        .at(-1)
    ).toBe('Bereit')
    expect(() =>
      execFileSync(process.execPath, [join(root, 'out/backend/index.cjs')], {
        ...options,
        stdio: 'pipe'
      })
    ).toThrow()
    await rename(join(root, 'parked-i18next'), join(root, 'node_modules/i18next'))
    const manifest = JSON.parse(
      await readFile(join(root, 'node_modules/i18next/package.json'), 'utf8')
    )
    await put(
      'node_modules/i18next/package.json',
      JSON.stringify({ ...manifest, version: '99.0.0' })
    )
    const future = await createBackendBuilder({ root, desktop: true })
    try {
      await future.rebuild()
    } finally {
      await future.dispose()
    }
    expect(
      desktopBackendDependencies(
        dependencies,
        JSON.parse(
          await readFile(join(root, 'out/desktop-backend-build/dependencies.json'), 'utf8')
        )
      )
    ).toEqual(['i18next'])
    expect(await readFile(join(root, 'out/backend/index.cjs'), 'utf8')).toBe(cli)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('rebuilds raw resources, worker edits and newly discovered workers without Electron imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-backend-build-'))
  const put = async (file: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  const builder = await createBackendBuilder({ root, development: true })
  try {
    await put(
      'packages/open-science/installation-startup.cjs',
      await readFile(
        new URL('../packages/open-science/installation-startup.cjs', import.meta.url),
        'utf8'
      )
    )
    await put('package.json', JSON.stringify({ dependencies: {} }))
    await put(
      'src/shared/i18n/locales/de.json',
      JSON.stringify({ common: { a: 'a' }, native: {}, renderer: { hidden: 'hidden' } })
    )
    await put('src/main/message.txt', 'before')
    const entry =
      'import text from "./message.txt?raw"; import worker from "./worker\'s-雪?nodeWorker"; console.log(text); worker().once("message", console.log); export { worker }'
    await put('src/main/node-entry.ts', entry)
    await put(
      "src/main/worker's-雪.ts",
      'import { parentPort } from "node:worker_threads"; parentPort.postMessage("worker-before")'
    )
    expect(await builder.rebuild()).toBe(1)
    const run = (): string =>
      execFileSync(process.execPath, [join(root, 'out/backend/index.cjs')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          OPEN_SCIENCE_CONFIG_ROOT: join(root, 'config'),
          OPEN_SCIENCE_INSTALLATION_STATE_ROOT: join(root, 'installation-state')
        }
      }).trim()
    expect(run()).toBe('before\nworker-before')
    await put('src/main/message.txt', 'after')
    await put(
      "src/main/worker's-雪.ts",
      'import { parentPort } from "node:worker_threads"; parentPort.postMessage("worker-after")'
    )
    expect(await builder.rebuild()).toBe(1)
    expect(run()).toBe('after\nworker-after')
    const worker = (await readdir(join(root, 'out/backend'))).find(
      (name) => name.startsWith('worker-') && name.endsWith('.cjs')
    )!
    expect(worker).toMatch(/^worker-[a-f0-9]{64}\.cjs$/)
    expect(await readFile(join(root, 'out/backend', worker), 'utf8')).toContain('worker-after')
    await put('src/main/second.ts', 'console.log("second-worker")')
    await put(
      'src/main/node-entry.ts',
      `${entry}; import second from "./second?nodeWorker"; export { second }`
    )
    expect(await builder.rebuild()).toBe(2)
    await put('src/main/node-entry.ts', 'console.log("no-workers")')
    expect(await builder.rebuild()).toBe(0)
    await put(
      'src/shared/i18n/locales/de.json',
      JSON.stringify({ common: { a: 'updated' }, native: {}, renderer: {} })
    )
    await builder.rebuild()
    expect(
      JSON.parse(await readFile(join(root, 'out/backend/native-locales/de.json'), 'utf8'))
    ).toEqual({ common: { a: 'updated' }, native: {} })
    await put('src/main/node-entry.ts', 'import "electron"')
    await expect(builder.rebuild()).rejects.toThrow(/Electron|electron/)
    await put('src/main/node-entry.ts', 'console.log("recovered")')
    await builder.rebuild()
    expect(run()).toBe('recovered')
  } finally {
    await builder.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('bundles the local worker without native ONNX and preserves real text generation', async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), 'node_modules/.cache/local-translation-'))
  try {
    const model = join(root, '模型 # fixture')
    await mkdir(model)
    // ONNX opset 13 Gather maps prompt -> ok -> EOS. This exercises actual tokenization,
    // model loading, WASM generation, output limits, repeated requests and disposal offline.
    await writeFile(
      join(model, 'model_quantized.onnx'),
      Buffer.from(
        'CAg63wEKIgoFdGFibGUKCWlucHV0X2lkcxIGbG9naXRzIgZHYXRoZXISE3BhY2thZ2luZy1jYXVzYWwtbG0qTwgECAQQAUIFdGFibGVKQAAAAAAAAAAAAAAgQQAAAAAAAAAAAAAAAAAAIEEAAAAAAAAAAAAAAAAAAAAAAAAgQQAAAAAAAAAAAAAAAAAAIEFaKAoJaW5wdXRfaWRzEhsKGQgHEhUKBxIFYmF0Y2gKChIIc2VxdWVuY2ViKQoGbG9naXRzEh8KHQgBEhkKBxIFYmF0Y2gKChIIc2VxdWVuY2UKAggEQgIQDQ==',
        'base64'
      )
    )
    await writeFile(
      join(model, 'config.json'),
      JSON.stringify({
        model_type: 'gpt2',
        n_layer: 0,
        n_head: 1,
        n_embd: 4,
        vocab_size: 4,
        bos_token_id: 1,
        eos_token_id: 3,
        pad_token_id: 3
      })
    )
    await writeFile(
      join(model, 'tokenizer.json'),
      JSON.stringify({
        version: '1.0',
        added_tokens: [
          {
            id: 3,
            content: '<eos>',
            special: true,
            single_word: false,
            lstrip: false,
            rstrip: false,
            normalized: false
          }
        ],
        pre_tokenizer: { type: 'Whitespace' },
        model: {
          type: 'WordLevel',
          vocab: { '<unk>': 0, prompt: 1, ok: 2, '<eos>': 3 },
          unk_token: '<unk>'
        },
        decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
        post_processor: null,
        normalizer: null,
        truncation: null,
        padding: null
      })
    )
    await writeFile(
      join(model, 'tokenizer_config.json'),
      JSON.stringify({
        tokenizer_class: 'PreTrainedTokenizer',
        eos_token: '<eos>',
        unk_token: '<unk>',
        model_max_length: 4096,
        chat_template: "{{ 'prompt' }}"
      })
    )
    const result = await buildLocalTranslationWorker(process.cwd(), root)
    expect(result?.dependencies).toEqual(
      expect.arrayContaining(['onnxruntime-web', 'onnxruntime-common', 'sharp'])
    )
    expect(result?.dependencies).not.toContain('onnxruntime-node')
    expect(result?.dependencies).not.toContain('@huggingface/transformers')
    await writeFile(
      join(root, 'verify.mjs'),
      `
      import { registerHooks } from 'node:module';
      registerHooks({resolve(name, context, next) {
        if (name === 'onnxruntime-node' || name.startsWith('@huggingface/transformers') || name === 'onnxruntime-web/webgpu')
          throw new Error('Forbidden inference dependency: ' + name);
        return next(name, context);
      }});
      await import('./worker.mjs');
    `
    )
    const request = {
      id: 'normal',
      directory: model,
      systemPrompt: 'Translate',
      prompt: 'Scientific text',
      outputLimitBytes: 1024
    }
    const input =
      [request, { ...request, id: 'repeat' }, { ...request, id: 'limit', outputLimitBytes: 1 }]
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n'
    const output = execFileSync(process.execPath, [join(root, 'verify.mjs')], {
      input,
      encoding: 'utf8',
      timeout: 30_000
    })
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    expect(output).toEqual([
      {
        id: 'normal',
        text: 'ok',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 2 }
      },
      {
        id: 'repeat',
        text: 'ok',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 2 }
      },
      { id: 'limit', error: 'inference-failed' }
    ])
    expect(await readFile(join(root, 'transformers-LICENSE'), 'utf8')).toContain('Apache License')
    expect(await readFile(join(root, 'jinja-LICENSE'), 'utf8')).toContain('MIT License')
    expect(await readFile(join(root, 'tokenizers-LICENSE'), 'utf8')).toContain('Apache License')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)

it.each([
  ['99.0.0', '1.26.0-dev.20260416-b7804b056c'],
  ['4.2.0', '99.0.0']
])(
  'retains the original inference closure for unaudited versions (%s, %s)',
  async (transformers, wasm) => {
    const root = await mkdtemp(join(tmpdir(), 'translation-version-'))
    try {
      for (const [name, version] of [
        ['@huggingface/transformers', transformers],
        ['onnxruntime-web', wasm]
      ]) {
        const directory = join(root, 'node_modules', name)
        await mkdir(join(directory, 'dist'), { recursive: true })
        await writeFile(
          join(directory, 'package.json'),
          JSON.stringify({ name, version, main: 'dist/index.js' })
        )
        await writeFile(join(directory, 'dist/index.js'), '')
      }
      expect(await buildLocalTranslationWorker(root, join(root, 'output'))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
