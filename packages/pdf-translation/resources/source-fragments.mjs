/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-only source recovery. */
// Re-read exact item identities only after ordinary native proof fails. Keep one
// lazy PDF.js document per generation; neither saved snapshots nor ink change.
export function createSourceFragmentRecovery(data, pages) {
  let loading
  const recover = async (unit) => {
    if (!unit.fragments.every((fragment) => Array.isArray(fragment.items) && fragment.items.length))
      return
    if (!loading) {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      loading = getDocument({ data: data.slice(), useSystemFonts: true })
    }
    const document = await loading.promise
    const fragments = []
    let recovered = false
    for (const fragment of unit.fragments) {
      const items = fragment.items
      if (!items?.length || items.length > 500) return
      const page = await document.getPage(fragment.pageNumber)
      const size = pages[fragment.pageNumber - 1]
      const viewport = page.getViewport({ scale: 1 })
      if (
        viewport.rotation ||
        viewport.transform.slice(0, 4).some((value, index) => value !== [1, 0, 0, -1][index]) ||
        viewport.transform[4] !== 0 ||
        viewport.transform[5] !== size.height ||
        Math.abs(viewport.width - size.width) > 0.01 ||
        Math.abs(viewport.height - size.height) > 0.01
      )
        return
      const content = await page.getTextContent()
      const owned = new Set(items.map((item) => item.index))
      if (owned.size !== items.length) return
      for (const [offset, item] of items.entries()) {
        const raw = content.items[item.index]
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          (offset && item.index <= items[offset - 1].index) ||
          raw?.str !== item.text
        )
          return
      }
      // Even contiguous items can have an oversized aggregate advance box.
      // Retry their independently re-read boxes; native preflight must still
      // prove every item's complete text and the aggregate source sequence.
      for (const item of items) {
        const raw = content.items[item.index]
        const [a, b, c, d, x, baseline] = raw.transform
        if (raw.dir !== 'ltr' || a <= 0 || d <= 0 || b !== 0 || c !== 0 || raw.width <= 0) return
        // Same upright em-box convention as reader/layout.ts. Native glyph
        // preflight below remains authoritative for actual painted bounds.
        const rect = {
          x: x / size.width,
          y: (size.height - baseline - d * 0.85) / size.height,
          width: raw.width / size.width,
          height: (d * 1.1) / size.height
        }
        const old = fragment.rect
        // An item ID never authorizes moving an unrelated source rectangle.
        if (
          !Object.values(rect).every(Number.isFinite) ||
          rect.x < old.x - 0.05 / size.width ||
          rect.y < old.y - 0.05 / size.height ||
          rect.x + rect.width > old.x + old.width + 0.05 / size.width ||
          rect.y + rect.height > old.y + old.height + 0.05 / size.height
        )
          return
        fragments.push({ ...fragment, rect, items: [item] })
      }
      recovered = true
    }
    if (recovered && fragments.length <= 500) return { ...unit, fragments }
  }
  return {
    async recover(unit) {
      try {
        return await recover(unit)
      } catch {
        // PDF.js is optional evidence. Its parse/extraction failure must not
        // replace the native source failure or the existing retention policy.
        return undefined
      }
    },
    async close() {
      try {
        await loading?.destroy()
      } catch {
        // Attempt cleanup even after failed loading without replacing the
        // generation result (or its original native validation error).
      }
    }
  }
}
