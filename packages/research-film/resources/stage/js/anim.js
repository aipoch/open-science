// Deterministic animation helpers: everything is a pure function of time.
window.A = {}

window.A.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
window.A.lerp = (a, b, p) => a + (b - a) * p
window.A.ease = {
  linear: (p) => p,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  out: (p) => 1 - Math.pow(1 - p, 3),
  outQuint: (p) => 1 - Math.pow(1 - p, 5),
  outExpo: (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  in: (p) => p * p * p,
  outBack: (p) => {
    const c1 = 1.70158,
      c3 = c1 + 1
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
  }
}
// progress of t through [a, b], eased
window.A.seg = (t, a, b, ease = window.A.ease.out) => ease(window.A.clamp((t - a) / (b - a)))
// 0→1 at [a, a+inD], 1→0 at [b-outD, b]
window.A.window = (t, a, b, inD = 0.4, outD = 0.4) =>
  Math.min(window.A.seg(t, a, a + inD), 1 - window.A.seg(t, b - outD, b, window.A.ease.in))

// seeded PRNG (mulberry32) so procedural art is identical every frame/render
window.A.rng = (seed) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

window.A.h = (tag, attrs = {}, ...kids) => {
  const svg = [
    'svg',
    'g',
    'path',
    'circle',
    'ellipse',
    'line',
    'rect',
    'polyline',
    'text',
    'defs',
    'linearGradient',
    'stop'
  ].includes(tag)
  const el = svg
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.setAttribute('class', v)
    else if (k === 'html') el.innerHTML = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else el.setAttribute(k, k === 'src' ? (window.VIDEO_ASSETS?.[v] ?? v) : v)
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k))
  return el
}

window.A.fmt = (x, d = 1) => x.toFixed(d)
window.A.fmtInt = (x) => Math.round(x).toLocaleString('en-US')
