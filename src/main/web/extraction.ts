import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { WebResource } from './transport'
import { WebToolError } from './errors'

export const WEB_EXTRACTOR_VERSION = 'semantic-v1'
export type WebExtraction = {
  text: string
  title?: string
  method: 'main_content' | 'semantic_dom' | 'plain_text'
  quality: 'normal' | 'degraded'
}
type WorkerExtraction = WebExtraction & { loginControl?: boolean; challengeControl?: boolean }

// This function is self-contained because it runs in a bounded, terminable worker. HTML parsing
// never executes page code, and deeply nested markup cannot exhaust the host's call stack.
function extractInWorker(
  body: string,
  html: boolean,
  parse: (html: string) => unknown
): WorkerExtraction {
  const normalize = (text: string): string =>
    text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  if (!html) return { text: normalize(body), method: 'plain_text', quality: 'normal' }
  type Node = {
    nodeName: string
    tagName?: string
    value?: string
    childNodes?: Node[]
    attrs?: Array<{ name: string; value: string }>
  }
  const root = parse(body) as Node
  const noise = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'iframe',
    'svg',
    'canvas',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'button',
    'input',
    'select',
    'textarea'
  ])
  const attr = (node: Node, key: string): string =>
    node.attrs?.find((item) => item.name === key)?.value ?? ''
  const invisible = (node: Node): boolean =>
    !!node.attrs?.some((item) => item.name === 'hidden' || item.name === 'inert') ||
    attr(node, 'aria-hidden') === 'true' ||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node, 'style'))
  const hidden = (node: Node): boolean => noise.has(node.tagName ?? '') || invisible(node)
  let title: string | undefined
  let contentRoot: Node | undefined
  let mainRoot: Node | undefined
  let loginControl = false,
    challengeControl = false
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (invisible(node)) continue
    if (node.tagName === 'input' && attr(node, 'type').toLowerCase() === 'password')
      loginControl = true
    if (
      /(?:g-recaptcha|h-captcha|cf-chl-|cf-turnstile)/i.test(
        attr(node, 'class') + ' ' + attr(node, 'id')
      )
    )
      challengeControl = true
    if (node.tagName === 'title')
      title = node.childNodes
        ?.map((child) => child.value ?? '')
        .join('')
        .trim()
        .slice(0, 512)
    if (node.tagName === 'body') contentRoot = node
    if (
      !mainRoot &&
      (node.tagName === 'main' || node.tagName === 'article' || attr(node, 'role') === 'main')
    )
      mainRoot = node
    if (!['script', 'style', 'noscript', 'template', 'svg'].includes(node.tagName ?? ''))
      for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index--)
        pending.push(node.childNodes![index])
  }
  const parts: string[] = []
  const tasks: Array<Node | string> = [mainRoot ?? contentRoot ?? root]
  const block = new Set([
    'p',
    'div',
    'section',
    'article',
    'main',
    'blockquote',
    'ul',
    'ol',
    'dl',
    'dt',
    'dd',
    'table'
  ])
  while (tasks.length) {
    const task = tasks.pop()!
    if (typeof task === 'string') {
      parts.push(task)
      continue
    }
    if (hidden(task)) continue
    if (task.nodeName === '#text') {
      parts.push(task.value ?? '')
      continue
    }
    const tag = task.tagName ?? ''
    if (tag === 'br') {
      parts.push('\n')
      continue
    }
    let before = '',
      after = ''
    if (/^h[1-6]$/.test(tag)) {
      before = '\n\n' + '#'.repeat(Number(tag[1])) + ' '
      after = '\n\n'
    } else if (tag === 'li') {
      before = '\n- '
      after = '\n'
    } else if (tag === 'pre') {
      before = '\n\n```\n'
      after = '\n```\n\n'
    } else if (tag === 'tr') {
      before = '\n| '
      after = '\n'
    } else if (tag === 'td' || tag === 'th') after = ' | '
    else if (block.has(tag)) {
      before = '\n\n'
      after = '\n\n'
    }
    parts.push(before)
    tasks.push(after)
    for (let index = (task.childNodes?.length ?? 0) - 1; index >= 0; index--)
      tasks.push(task.childNodes![index])
  }
  return {
    text: normalize(parts.join('')),
    ...(title ? { title } : {}),
    loginControl,
    challengeControl,
    method: mainRoot ? 'main_content' : 'semantic_dom',
    quality: mainRoot ? 'normal' : 'degraded'
  }
}

export const extractWebResource = async (
  resource: WebResource,
  signal: AbortSignal
): Promise<WebExtraction> => {
  signal.throwIfAborted()
  let body: string
  try {
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(resource.contentType)?.[1] ?? 'utf-8'
    body = new TextDecoder(charset, { fatal: false }).decode(resource.body)
  } catch {
    throw new WebToolError('EXTRACTION_FAILED')
  }
  if (body.includes('\u0000')) throw new WebToolError('UNSUPPORTED_CONTENT_TYPE')
  const html = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(resource.contentType)
  let parserPath: string
  try {
    parserPath = createRequire(import.meta.url).resolve('parse5')
  } catch {
    throw new WebToolError('EXTRACTION_FAILED')
  }
  const source = `const {parentPort,workerData}=require('node:worker_threads');
    try { parentPort.postMessage((${extractInWorker.toString()})(workerData.body,workerData.html,require(workerData.parserPath).parse)); }
    catch { parentPort.postMessage({failed:true}); }`
  return new Promise<WebExtraction>((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      execArgv: [],
      workerData: { body, html, parserPath },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    })
    let settled = false
    const finish = (result?: WebExtraction, error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = (): void => finish(undefined, signal.reason)
    const timer = setTimeout(() => finish(undefined, new WebToolError('EXTRACTION_FAILED')), 2500)
    signal.addEventListener('abort', abort, { once: true })
    worker.once('error', () => finish(undefined, new WebToolError('EXTRACTION_FAILED')))
    worker.once('exit', () => finish(undefined, new WebToolError('EXTRACTION_FAILED')))
    worker.once('message', (result: WorkerExtraction & { failed?: boolean }) => {
      // A visible control plus explicit blocking-wall copy is evidence. Widgets in a readable
      // article or hidden login dialog are not proof that access to the article was blocked.
      const wallCopy = result.text?.replace(/^#+\s*/gm, '').trim() ?? ''
      if (result.failed || !result.text?.trim())
        finish(undefined, new WebToolError('EXTRACTION_FAILED'))
      else if (
        result.loginControl &&
        (/^(?:sign in|log in|login|authentication required)$/i.test(wallCopy) ||
          (wallCopy.length < 500 &&
            /(?:please |you must |required to )?(?:sign in|log in|login)\s+(?:to continue (?:reading|viewing|accessing)|to (?:read|view|access) (?:this|the) (?:page|article|content))/i.test(
              wallCopy
            )))
      )
        finish(undefined, new WebToolError('AUTH_REQUIRED'))
      else if (
        result.challengeControl &&
        wallCopy.length < 300 &&
        /^(?:verify (?:that )?you are (?:a )?human|checking your browser|check browser|just a moment|security verification)(?:[.!…\s].*)?$/i.test(
          wallCopy
        )
      )
        finish(undefined, new WebToolError('EXTRACTION_FAILED'))
      else finish(result)
    })
    if (signal.aborted) abort()
  })
}
