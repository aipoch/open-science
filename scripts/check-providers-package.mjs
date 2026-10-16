/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:providers-package.')
const plan = familyVerificationPlan(['diagnostics', 'providers'])
console.log('Providers verification:', JSON.stringify(plan))
if (!plan.tests.includes('providers')) process.exit(0)
const modelDirectoryIndex = process.argv.indexOf('--local-model-dir')
const modelDirectory = modelDirectoryIndex < 0 ? undefined : process.argv[modelDirectoryIndex + 1]
if (modelDirectoryIndex >= 0 && (!modelDirectory || !isAbsolute(modelDirectory)))
  throw new Error('--local-model-dir requires an absolute path to the pinned Qwen model assets.')
const work = mkdtempSync(join(tmpdir(), 'providers-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = isolatedPackageEnvironment()
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const tarballs = {}
  for (const name of ['diagnostics', 'providers']) {
    const source = join(work, name)
    mkdirSync(source)
    for (const file of [
      'src',
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'vitest.config.ts',
      'tsc.cjs',
      'README.md',
      'LICENSE',
      ...(name === 'providers' ? ['test', 'test-ownership.md', 'resources'] : [])
    ])
      cpSync(join(root, 'packages', name, file), join(source, file), { recursive: true })
    // npm install saves the archive spec locally; restore the publishable version declaration before pack.
    const manifest = readFileSync(join(source, 'package.json'), 'utf8')
    npm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...offline,
        ...(name === 'providers' ? [tarballs.diagnostics] : [])
      ],
      source
    )
    writeFileSync(join(source, 'package.json'), manifest)
    npm(['run', 'build'], source)
    npm(['run', 'typecheck'], source)
    // Upstream builds do not rerun unchanged upstream unit suites.
    if (name === 'providers') npm(['test'], source)
    const packed = JSON.parse(
      execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', work], {
        cwd: source,
        env,
        encoding: 'utf8'
      })
    )[0]
    tarballs[name] = join(work, packed.filename)
    for (const { path } of packed.files) {
      assert.match(
        path,
        /^(?:dist\/|resources\/|README\.md$|test-ownership\.md$|LICENSE$|package\.json$)/
      )
      assert.ok(!/\.test\./.test(path), `Packed test: ${path}`)
      if (/\.(?:js|ts)$/.test(path)) {
        const text = readFileSync(join(source, path), 'utf8')
        for (const forbidden of [
          root,
          'src/main/',
          'src/shared/',
          '@renderer/',
          'test/setup',
          "from 'electron'",
          'require("electron")'
        ])
          assert.ok(!text.includes(forbidden), `${path} references ${forbidden}`)
      }
    }
  }
  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@aipoch/providers': `file:${tarballs.providers}`,
        '@aipoch/diagnostics': `file:${tarballs.diagnostics}`
      },
      devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1', esbuild: '^0.25.0' }
    })
  )
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  for (const name of ['diagnostics', 'providers']) {
    const installed = realpathSync(join(consumer, 'node_modules/@aipoch', name))
    assert.ok(
      installed.startsWith(realpathSync(consumer) + sep),
      `External dependency link: ${installed}`
    )
    rmSync(join(work, name), { recursive: true })
  }
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import * as providers from '@aipoch/providers'
import * as protocol from '@aipoch/providers/protocol'
import * as client from '@aipoch/providers/client'
import * as errors from '@aipoch/providers/errors'
import * as transport from '@aipoch/providers/transport'
import * as local from '@aipoch/providers/local'
const require = createRequire(import.meta.url)
for (const [entry, esm] of Object.entries({ '': providers, '/protocol': protocol, '/client': client, '/errors':errors, '/transport':transport, '/local':local })) {
  assert.ok(realpathSync(require.resolve('@aipoch/providers' + entry)).startsWith(realpathSync('.') + sep))
  const cjs = require('@aipoch/providers' + entry)
  for (const key of Object.keys(cjs)) assert.equal(cjs[key], (esm as Record<string, unknown>)[key])
}
for (const entry of ['/classification', '/providers', '/catalog', '/package.json', '/dist/client.js', '/src/provider-registry', '/provider-text-generation']) {
  assert.throws(() => require('@aipoch/providers' + entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  await assert.rejects(import('@aipoch/providers' + entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
for (const name of ['getVendorModelIds','getVendorModelContextWindow','resolveVendorApiEndpoints','vendorHasRegions','isVendorModelResponsesSupported','TYPESAFE_MODEL_ID']) assert.equal(Object.hasOwn(providers,name),false)
for (const name of ['anthropicMessagesUrl','openAiResponsesUrl']) assert.equal(Object.hasOwn(protocol,name),false)
assert.equal(providers.getOfficialVendor('openai')?.id, 'openai')
assert.equal(transport.isSecureProviderUrl(new URL('http://example.test')), false)
assert.equal(protocol.openAiChatCompletionsUrl({ baseUrl: 'https://example.test/proxy' }), 'https://example.test/proxy/v1/chat/completions')
assert.equal(protocol.convertResponsesRequest({body:{input:'Hello'}, model:'model'}).model, 'model')
assert.deepEqual(protocol.normalizeOpenAiChatModelStepUsage({prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: {cached_tokens: 3}}), {inputTokens:7,cacheTokens:3,cachedReadTokens:3,cachedWriteTokens:0,outputTokens:2})
const config: client.ProviderConfiguration = {id:'custom',textGeneration:{protocol:'openai',url:'http://127.0.0.1:9090/v1/chat/completions'}}
const service: client.TextGenerationModel = client.createProvider({...config,fetch:async (url, init) => {
  assert.equal(url, 'http://127.0.0.1:9090/v1/chat/completions'); assert.equal(init?.redirect,'manual')
  return Response.json({choices:[{finish_reason:'stop',message:{content:'Installed consumer'}}]})
}}).textGenerationModel('m')
const builtin = client.createProvider({id:'openai',key:'token',fetch:async(url,init)=>{
 assert.equal(url,'https://api.openai.com/v1/responses')
 assert.equal(new Headers(init?.headers).get('authorization'),'Bearer token')
 return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Standalone'}]}]})
}}).textGenerationModel('new-model')
assert.equal((await builtin.generate({prompt:'hello'})).text,'Standalone')
const generationInput: client.TextGenerationInput = {systemPrompt:'Answer',prompt:'Hello',signal:new AbortController().signal,maxOutputTokens:16,outputLimitBytes:1024}
assert.equal(service.capability,'text-generation')
assert.deepEqual(await service.generate(generationInput),{text:'Installed consumer',stopReason:'end_turn'})
const adapter = protocol.createResponsesAdapter()
const turn=adapter.prepare({scope:'a',body:{input:'Hello',stream:false}})
const result=await (await turn.convert(Response.json({id:'installed',model:'m',choices:[{finish_reason:'stop',message:{content:'Answer',reasoning_content:'private'}}]}))).json()
assert.equal(result.output[0].content[0].text,'Answer')
assert.equal(adapter.prepare({scope:'a',body:{input:result.output}}).request.messages[0].reasoning_content,'private')
assert.equal(adapter.prepare({scope:'b',body:{input:result.output}}).request.messages[0].reasoning_content,undefined)
adapter.clear()
assert.equal(adapter.prepare({scope:'a',body:{input:result.output}}).request.messages[0].reasoning_content,undefined)
adapter.dispose()
assert.throws(()=>adapter.prepare({body:{input:'hello'}}),/disposed/)
assert.equal(typeof errors.providerTextGenerationFailure, 'function')
const body = new Response('bounded')
assert.equal(await transport.readBoundedResponseText(body, 32, 'consumer'), 'bounded')
const classifier: client.ClassificationModel = client.createProvider({id:'typesafe',fetch:async(url)=>{assert.equal(url,'https://api.typesafe.ai/v1/systemone');return Response.json({model:'jev',usage:{input_tokens:2,output_tokens:1},answers:{question:{type:'noul',noul:0.75}}})}}).classificationModel('jev')
const decision = await classifier.classify({state:'hello',questions:{question:{type:'noul'}}})
assert.equal(decision.answers.question.type,'noul')
const image: client.ClassificationImage = {type:'image',format:'png',data_base64:'aW1hZ2U='}
const imageClassifier = client.createProvider({id:'openrouter',fetch:async(url,init)=>{
  assert.equal(url,'https://openrouter.ai/api/v1/systemone')
  assert.equal(new Headers(init?.headers).get('TypeSafe-Danger-Zone-Images'),'true')
  assert.deepEqual(JSON.parse(String(init?.body)),{model:'typesafe/jev-1.14',state:{text:'figure',images:['asset']},questions:{},assets:{asset:image}})
  return Response.json({model:'typesafe/jev-1.14',usage:{input_tokens:2,output_tokens:1},answers:{}})
}}).classificationModel('typesafe/jev-1.14')
assert.equal((await imageClassifier.classify({state:'figure',images:{asset:image},questions:{}})).model,'typesafe/jev-1.14')

assert.equal(providers.getProviderModels('typesafe','classification')[0].modelId,'jev-latest')
assert.equal(providers.getProviderModels('local','text-generation')[0].execution,'local-worker')
assert.equal(providers.getProviderDefinition('openrouter')?.classification?.models[0].id,'typesafe/jev-1.13')
assert.deepEqual(protocol.sanitizeXaiResponsesRequest({input:'hello',safety_identifier:'secret'}),{input:'hello'})
assert.ok(protocol.countAnthropicInputTokens({messages:[{role:'user',content:'hello'}]})>0)
const namespace = protocol.prepareNativeResponsesRequest({tools:[{type:'namespace',name:'tools',tools:[{type:'function',name:'run'}]}]})
assert.deepEqual(namespace.restore({type:'function_call',name:'tools__run'}),{type:'function_call',namespace:'tools',name:'run'})
const models=await client.createProvider({id:'deepseek',key:'discovery-token',fetch:async(url,init)=>{assert.equal(url,'https://api.deepseek.com/v1/models');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer discovery-token');return Response.json({data:[{id:'m'}]})}}).listModels()
assert.deepEqual(models.models,['m'])
const emptyLocalRuntime = local.createLocalTextRuntime(); await emptyLocalRuntime.dispose()
const cancelledDiscovery = await client.createProvider({id:'deepseek',fetch:async()=>{throw new Error('Cancelled discovery sent a request')}}).listModels({signal:AbortSignal.abort(new Error('cancelled'))})
assert.deepEqual(cancelledDiscovery,{ok:false,message:'cancelled'})
console.log('PASS installed providers CJS/ESM identities, exports, types, classification, discovery, native Responses, xAI and client')
`
  )
  writeFileSync(
    join(consumer, 'consumer.cts'),
    `
import providers = require('@aipoch/providers')
import protocol = require('@aipoch/providers/protocol')
import client = require('@aipoch/providers/client')
import local = require('@aipoch/providers/local')
const image: client.ClassificationImage = {type:'image',format:'png',data_base64:'aW1hZ2U='}
const classify: client.ClassificationInput = {state:'s',questions:{},images:{asset:image}}
const classifier: client.ClassificationModel = client.createProvider({id:'typesafe'}).classificationModel('jev-latest')
void classifier
void classify; const localRuntime: local.LocalTextRuntime = local.createLocalTextRuntime(); void localRuntime.dispose()
const endpoint: providers.ChatApiEndpoint = 'openai'
const config: client.ProviderConfiguration = {id:'custom',textGeneration:{protocol:endpoint,url:'https://example.test/v1/chat/completions'}}
const usage: protocol.ProviderTokenUsage = {inputTokens:1,cacheTokens:0,outputTokens:2}
const model: client.TextGenerationModel = client.createProvider(config).textGenerationModel('m')
const input: client.TextGenerationInput = {systemPrompt:'s',prompt:'p',signal:new AbortController().signal,maxOutputTokens:16,outputLimitBytes:1024}
void model; void input; void config; void usage
`
  )
  run(
    [
      'node_modules/typescript/bin/tsc',
      'consumer.mts',
      'consumer.cts',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict'
    ],
    consumer
  )
  writeFileSync(
    join(consumer, 'browser.mjs'),
    `import { getProviderDefinition, getProviderModels, getOfficialVendor, getVendorModelReasoningCapability } from '@aipoch/providers'; import { providerTextGenerationFailure } from '@aipoch/providers/errors'; import { isSecureProviderUrl } from '@aipoch/providers/transport'; globalThis.providerDefinitions = {getProviderDefinition,getProviderModels,getOfficialVendor,providerTextGenerationFailure,getVendorModelReasoningCapability}; if(!isSecureProviderUrl(new URL('https://example.test')))throw new Error('Browser transport URL helper failed');`
  )
  run(
    [
      '--input-type=module',
      '-e',
      "import {build} from 'esbuild'; await build({entryPoints:['browser.mjs'],bundle:true,platform:'browser',outfile:'browser-bundle.js'})"
    ],
    consumer
  )
  npm(['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  run(['consumer.mjs'], consumer)
  run(['consumer.cjs'], consumer)
  run(['browser-bundle.js'], consumer)
  // Remote consumers remain usable without local inference peers. Install the explicitly
  // documented local runtime only for the worker acceptance stage, after deleting source copies.
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      ...offline,
      '@huggingface/transformers@4.2.0',
      'onnxruntime-web@1.26.0-dev.20260416-b7804b056c'
    ],
    consumer
  )
  writeFileSync(
    join(consumer, 'local-probe.mjs'),
    `
import assert from 'node:assert/strict'
import { writeFile, unlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createLocalTextRuntime } from '@aipoch/providers/local'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
let workerPath
const localRuntime = createLocalTextRuntime({process:{
 launch(path) {workerPath=path; return spawn(process.execPath,[path],{stdio:['pipe','pipe','pipe']})},
 async terminate(child) {if(child.exitCode!==null || child.signalCode!==null)return; const exited=once(child,'exit');child.kill('SIGKILL');await exited}
}})
try {
 const model=localRuntime.createModel({directory:resolve('missing-model')})
 await assert.rejects(model.generate({prompt:'hello'}),/inference failed/)
 await model.dispose()
} finally {await localRuntime.dispose()}
// Exercise the public default Node lifecycle as well as the managed-process hook above.
const standalone = createLocalTextRuntime()
try {
 const model = standalone.createModel({directory:resolve('missing-default-model')})
 await assert.rejects(model.generate({prompt:'hello'}),/inference failed/)
 await model.dispose()
} finally {await standalone.dispose()}
if (process.argv[2]) {
 const runtime = createLocalTextRuntime()
 const model = runtime.createModel({directory:process.argv[2]})
 const started = performance.now()
 try {
  const input = {systemPrompt:'Translate into Chinese. Return only the translation.',prompt:'The sky is blue.'}
  const first = await model.generate(input)
  assert.match(first.text,/[\\u3400-\\u9fff]/u)
  assert.notEqual(first.text,input.prompt)
  assert.equal(first.stopReason,'end_turn')
  assert.ok(first.usage.inputTokens > 0 && first.usage.outputTokens > 0)
  const controller = new AbortController()
  const pending = model.generate({prompt:'Write a long essay about scientific discovery.',signal:controller.signal})
  const timer = setTimeout(()=>controller.abort(),25)
  try {await assert.rejects(pending,{name:'AbortError'})} finally {clearTimeout(timer)}
  const recovered = await model.generate(input)
  assert.match(recovered.text,/[\\u3400-\\u9fff]/u)
  assert.notEqual(recovered.text,input.prompt)
  assert.equal(recovered.stopReason,'end_turn')
  assert.ok(recovered.usage.inputTokens > 0 && recovered.usage.outputTokens > 0)
  await model.dispose()
  await assert.rejects(model.generate(input),/no longer available/)
  console.log('PASS installed Qwen inference, cancellation, recovery and model disposal',JSON.stringify({first,recovered,elapsedMs:Math.round(performance.now()-started)}))
 } finally {await runtime.dispose()}
}
await import(pathToFileURL(workerPath).href)
const ort=globalThis[Symbol.for('onnxruntime')]
const file=resolve('模型 # identity.onnx')
await writeFile(file,Buffer.from('CAg6RwoQCgF4EgF5IghJZGVudGl0eRIRcGFja2FnZWQtaWRlbnRpdHlaDwoBeBIKCggIARIECgIIA2IPCgF5EgoKCAgBEgQKAggDQgQKABAN','base64'))
let session
try {
 session=await ort.InferenceSession.create(file,{executionProviders:['wasm']})
 const input=new ort.Tensor('float32',new Float32Array([2,4,8]),[3])
 const output=await session.run({x:input})
 assert.deepEqual(Array.from(output.y.data),[2,4,8])
 output.y.dispose();input.dispose()
} finally {await session?.release();await unlink(file)}
console.log('PASS installed local worker real WASM inference, unicode paths and resource resolution')
`
  )
  execFileSync(process.execPath, ['local-probe.mjs', ...(modelDirectory ? [modelDirectory] : [])], {
    cwd: consumer,
    env,
    input: '',
    timeout: modelDirectory ? 600_000 : 120_000,
    stdio: ['pipe', 'inherit', 'inherit']
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}
