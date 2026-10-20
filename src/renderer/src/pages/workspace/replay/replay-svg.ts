// SVG is rendered as an isolated image, never inserted into the application DOM. Retain static
// chart primitives and local <use>/clip references, but remove active content and network fetches.
export const freezeReplaySvg = (source: string): string | undefined => {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  const svg = document.documentElement
  if (svg.localName !== 'svg' || document.querySelector('parsererror')) return undefined
  const unsafeStyle = (value: string): boolean =>
    /@|\\|:(?:hover|active|focus)|(?:animation|transition)\s*[:{]|expression\s*\(/iu.test(value) ||
    [...value.matchAll(/url\s*\(([^)]+)\)/giu)].some(
      (match) => !/^\s*['"]?#[\w:.-]+['"]?\s*$/u.test(match[1])
    )
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (
      [
        'script',
        'foreignobject',
        'animate',
        'animatemotion',
        'animatetransform',
        'set',
        'discard',
        'audio',
        'video',
        'iframe'
      ].includes(node.localName.toLowerCase())
    ) {
      node.remove()
      continue
    }
    if (node.localName === 'style' && unsafeStyle(node.textContent ?? '')) {
      node.remove()
      continue
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.localName.toLowerCase()
      const value = attribute.value
      const externalHref =
        name === 'href' &&
        !/^#[\w:.-]+$/u.test(value) &&
        !/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=\s]+$/iu.test(value)
      const embedded =
        name === 'href' ? /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/iu.exec(value) : null
      if (
        name.startsWith('on') ||
        externalHref ||
        (embedded && !staticRasterSource(embedded[1], embedded[2])) ||
        name === 'base' ||
        unsafeStyle(value)
      )
        node.removeAttributeNode(attribute)
    }
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
}

const staticRasterSource = (mimeType: string, payload: string): string | undefined => {
  try {
    const bytes = atob(payload)
    if (mimeType === 'image/png') {
      const uint32 = (offset: number): number =>
        (bytes.charCodeAt(offset) * 0x1000000 +
          (bytes.charCodeAt(offset + 1) << 16) +
          (bytes.charCodeAt(offset + 2) << 8) +
          bytes.charCodeAt(offset + 3)) >>>
        0
      for (let offset = 8; offset + 12 <= bytes.length;) {
        if (bytes.slice(offset + 4, offset + 8) === 'acTL') return undefined
        const next = offset + uint32(offset) + 12
        if (next <= offset) break
        offset = next
      }
    }
    if (mimeType === 'image/webp' && bytes.slice(12, 16) === 'VP8X' && bytes.charCodeAt(20) & 2)
      return undefined
    return `data:${mimeType};base64,${payload}`
  } catch {
    return undefined
  }
}

export const replayImageSource = (mimeType: string, payload: string): string | undefined => {
  if (['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].includes(mimeType))
    return staticRasterSource(mimeType, payload)
  if (mimeType === 'image/svg+xml') {
    try {
      const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
      return freezeReplaySvg(new TextDecoder().decode(bytes))
    } catch {
      return undefined
    }
  }
  return undefined
}
