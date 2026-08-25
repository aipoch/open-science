// jsdom's Blob has no stream(), so `new Response(new Blob(...))` throws in Node's undici.
// Production only reads `ok` / `status` / `blob()`, so tests can stub that shape directly.

const createCachedImageFetchResponse = (
  body = 'image bytes',
  type = 'image/png'
): { ok: true; status: 200; blob: () => Promise<Blob> } => ({
  ok: true,
  status: 200,
  blob: () => Promise.resolve(new Blob([body], { type }))
})

export { createCachedImageFetchResponse }
