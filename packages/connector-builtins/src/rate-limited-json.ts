import { abortableDelay, type ToolContext } from '@aipoch/connector-core'

// One limiter per upstream, shared by its descriptors across engine instances in this process.
export function rateLimitedJson(
  intervalMs: number
): (ctx: ToolContext, url: string) => Promise<unknown> {
  let nextRequestAt = 0
  return async (ctx, url) => {
    for (;;) {
      ctx.signal?.throwIfAborted()
      const wait = nextRequestAt - Date.now()
      if (wait <= 0) {
        nextRequestAt = Date.now() + intervalMs
        break
      }
      await abortableDelay(wait, ctx.signal)
    }
    // Retries inside the engine would bypass this upstream's request admission.
    return JSON.parse(await ctx.fetchText(url, 'application/json', { retry: false }))
  }
}
