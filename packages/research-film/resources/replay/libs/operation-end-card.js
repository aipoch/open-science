/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vendored standalone browser runtime. */
/* Original Open-Science end card, adapted to the operation replay frame clock. */
;(() => {
  'use strict'

  const { h } = window.OSKit
  const partsByNode = new WeakMap()
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
  const lerp = (from, to, progress) => from + (to - from) * progress
  const easeOut = (value) => 1 - Math.pow(1 - value, 3)
  const easeIn = (value) => value * value * value
  const linear = (value) => value
  const easeOutBack = (value) =>
    1 + 2.70158 * Math.pow(value - 1, 3) + 1.70158 * Math.pow(value - 1, 2)
  const seg = (time, start, end, easing = easeOut) => easing(clamp((time - start) / (end - start)))
  const el = (className, ...children) => h('div', { class: className }, ...children)

  function rng(seed) {
    return () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
  }

  function show(node, progress, distance = 18, scale = 1) {
    node.style.opacity = progress.toFixed(3)
    node.style.transform = `translateY(${((1 - progress) * distance).toFixed(1)}px) scale(${lerp(scale, 1, progress).toFixed(4)})`
  }

  const LOGO_DOTS = [
    { x: -0.012924, y: 0.472892, radius: 0.007784 },
    { x: 0.131586, y: 0.466715, radius: 0.012465 },
    { x: -0.16191, y: 0.448989, radius: 0.012465 },
    { x: 0.062366, y: 0.432197, radius: 0.01001 },
    { x: -0.071564, y: 0.427665, radius: 0.010452 },
    { x: 0.26355, y: 0.406139, radius: 0.007964 },
    { x: 0.192444, y: 0.394296, radius: 0.010934 },
    { x: -0.198676, y: 0.381144, radius: 0.009742 },
    { x: -0.035226, y: 0.371028, radius: 0.009845 },
    { x: -0.294712, y: 0.372418, radius: 0.007964 },
    { x: 0.093762, y: 0.363983, radius: 0.010916 },
    { x: -0.159346, y: 0.333163, radius: 0.008288 },
    { x: 0.304653, y: 0.31767, radius: 0.011835 },
    { x: 0.21201, y: 0.312884, radius: 0.011323 },
    { x: 0.379275, y: 0.305679, radius: 0.012465 },
    { x: 0.03661, y: 0.31467, radius: 0.006839 },
    { x: -0.302793, y: 0.297186, radius: 0.01174 },
    { x: -0.06186, y: 0.308778, radius: 0.005888 },
    { x: 0.130926, y: 0.289632, radius: 0.006601 },
    { x: -0.152828, y: 0.272535, radius: 0.005886 },
    { x: -0.389103, y: 0.259271, radius: 0.012465 },
    { x: -0.263001, y: 0.254961, radius: 0.007069 },
    { x: 0.08035, y: 0.240144, radius: 0.005697 },
    { x: 0.214012, y: 0.236114, radius: 0.007386 },
    { x: 0.301842, y: 0.223886, radius: 0.007543 },
    { x: 0.38527, y: 0.209823, radius: 0.009834 },
    { x: -0.226909, y: 0.209488, radius: 0.007331 },
    { x: -0.379551, y: 0.184014, radius: 0.010332 },
    { x: -0.163488, y: 0.185753, radius: 0.005194 },
    { x: 0.450166, y: 0.175169, radius: 0.007964 },
    { x: 0.277134, y: 0.159357, radius: 0.00851 },
    { x: -0.332208, y: 0.145845, radius: 0.007841 },
    { x: -0.280971, y: 0.125806, radius: 0.005886 },
    { x: -0.453117, y: 0.120612, radius: 0.007964 },
    { x: 0.361206, y: 0.107731, radius: 0.008965 },
    { x: 0.431057, y: 0.08131, radius: 0.009861 },
    { x: 0.311279, y: 0.066881, radius: 0.006979 },
    { x: -0.416624, y: 0.052698, radius: 0.010546 },
    { x: 0.247861, y: 0.053097, radius: 0.005194 },
    { x: 0.486554, y: 0.027388, radius: 0.012467 },
    { x: -0.304731, y: 0.029684, radius: 0.00677 },
    { x: -0.358303, y: 0.018986, radius: 0.010834 },
    { x: 0.379703, y: -0.021576, radius: 0.012119 },
    { x: -0.463213, y: -0.029978, radius: 0.012465 },
    { x: 0.316038, y: -0.032274, radius: 0.005925 },
    { x: 0.434801, y: -0.055291, radius: 0.009139 },
    { x: -0.238767, y: -0.05569, radius: 0.005252 },
    { x: -0.298784, y: -0.069468, radius: 0.006924 },
    { x: -0.413682, y: -0.0839, radius: 0.009003 },
    { x: -0.347098, y: -0.110321, radius: 0.006579 },
    { x: 0.467602, y: -0.123205, radius: 0.007964 },
    { x: 0.292335, y: -0.128399, radius: 0.006867 },
    { x: 0.345213, y: -0.148438, radius: 0.006579 },
    { x: -0.263741, y: -0.16195, radius: 0.006306 },
    { x: -0.43568, y: -0.177762, radius: 0.007964 },
    { x: 0.398485, y: -0.186604, radius: 0.010116 },
    { x: 0.172523, y: -0.188343, radius: 0.005194 },
    { x: -0.365454, y: -0.212416, radius: 0.011512 },
    { x: 0.240177, y: -0.21208, radius: 0.00736 },
    { x: -0.284853, y: -0.226479, radius: 0.010929 },
    { x: -0.202139, y: -0.238706, radius: 0.005886 },
    { x: -0.070817, y: -0.242737, radius: 0.005194 },
    { x: 0.412444, y: -0.261862, radius: 0.012465 },
    { x: 0.277432, y: -0.257553, radius: 0.008802 },
    { x: 0.163226, y: -0.275125, radius: 0.005886 },
    { x: 0.323191, y: -0.299778, radius: 0.010197 },
    { x: -0.119564, y: -0.292222, radius: 0.006152 },
    { x: -0.355934, y: -0.308269, radius: 0.012465 },
    { x: -0.192941, y: -0.315476, radius: 0.009262 },
    { x: 0.073337, y: -0.311369, radius: 0.006979 },
    { x: -0.283451, y: -0.320261, radius: 0.010921 },
    { x: -0.024542, y: -0.317261, radius: 0.006629 },
    { x: 0.176721, y: -0.335756, radius: 0.010578 },
    { x: -0.072535, y: -0.366576, radius: 0.011863 },
    { x: 0.054493, y: -0.37362, radius: 0.010942 },
    { x: 0.309199, y: -0.375011, radius: 0.007964 },
    { x: 0.217238, y: -0.383735, radius: 0.010331 },
    { x: -0.172561, y: -0.396888, radius: 0.010479 },
    { x: -0.249061, y: -0.408731, radius: 0.007964 },
    { x: 0.091052, y: -0.430256, radius: 0.01056 },
    { x: -0.042089, y: -0.434789, radius: 0.011807 },
    { x: 0.185251, y: -0.45158, radius: 0.012465 },
    { x: -0.108245, y: -0.469307, radius: 0.012465 },
    { x: 0.035458, y: -0.484072, radius: 0.007964 }
  ]
  function logoParticles(lockH) {
    const S = lockH * 4.2,
      dpr = window.devicePixelRatio || 1,
      logoSize = lockH * 1.0
    const cv = h('canvas', {
      class: 'dv-logo-particles',
      width: Math.round(S * dpr),
      height: Math.round(S * dpr),
      style: {
        width: `${S}px`,
        height: `${S}px`,
        left: `${(75.5 / 149) * lockH - S / 2}px`,
        top: `${(74.5 / 149) * lockH - S / 2}px`
      }
    })
    const g = cv.getContext('2d'),
      rnd = rng(20261028),
      rand = (a, b) => a + rnd() * (b - a)
    const ps = []
    for (let i = 0; i < LOGO_DOTS.length * 18; i++) {
      const dot = LOGO_DOTS[i % LOGO_DOTS.length],
        ang = i * 2.399963 + rand(-0.18, 0.18),
        rad = Math.sqrt(rnd()) * dot.radius
      const tx = (dot.x + Math.cos(ang) * rad) * logoSize,
        ty = (dot.y + Math.sin(ang) * rad) * logoSize
      const sph = S * rand(0.2, 0.3),
        lon = i * 2.399963 + rand(-0.18, 0.18),
        lat = Math.asin(rand(-0.92, 0.92)),
        vol = Math.pow(rand(0.58, 1), 0.38) * sph
      ps.push({
        tx,
        ty,
        sx: Math.cos(lat) * Math.cos(lon) * vol,
        sy: Math.sin(lat) * vol * 0.92,
        sz: Math.cos(lat) * Math.sin(lon) * vol,
        sph,
        r: rand(0.9, 1.7),
        phase: rand(0, 6.283),
        delay: rand(-0.035, 0.05),
        alpha: rand(0.5, 1)
      })
    }
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    // gather: 0→1 progress of the particles into the symbol; fade: 0→1 hand-over to the artwork
    const draw = (time, gather, fade) => {
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, S, S)
      if (fade >= 1) return
      const ms = time * 1000,
        c = S / 2,
        T = ease(clamp(gather, 0, 1))
      g.fillStyle = '#111111'
      for (const q of ps) {
        const lt = clamp(T + q.delay, 0, 1),
          settle = lt * lt * lt,
          travel = Math.sin(lt * Math.PI)
        const yaw = ms * 0.00034 + q.phase * 0.03,
          pitch = Math.sin(ms * 0.00022 + q.phase) * 0.16
        const x1 = q.sx * Math.cos(yaw) - q.sz * Math.sin(yaw),
          z1 = q.sx * Math.sin(yaw) + q.sz * Math.cos(yaw)
        const ry = q.sy * Math.cos(pitch) - z1 * Math.sin(pitch),
          rz = q.sy * Math.sin(pitch) + z1 * Math.cos(pitch)
        const persp = 1 + rz / (S * 1.6),
          depth = clamp((rz / (S * 0.36) + 1) / 2, 0, 1)
        const x =
          c +
          x1 * persp +
          (q.tx - x1 * persp) * lt +
          Math.cos(q.phase + ms * 0.0011) * travel * (1 - settle) * 8
        const y =
          c +
          ry * persp +
          (q.ty - ry * persp) * lt +
          Math.sin(q.phase + ms * 0.0013) * travel * (1 - settle) * 5.5
        const op = (0.22 + depth * 0.56 + lt * 0.16) * q.alpha * (1 - fade)
        if (op < 0.01) continue
        g.globalAlpha = op
        g.beginPath()
        g.arc(x, y, q.r * (0.68 + depth * 0.74) * (0.84 + lt * 0.1), 0, 6.283)
        g.fill()
      }
      g.globalAlpha = 1
    }
    return { cv, draw }
  }

  function create({ profile = 'marketing' } = {}) {
    const lock = h('img', {
      class: 'dv-lockup',
      src: 'brand/logos/open-science-lockup-black.svg',
      alt: 'Open-Science'
    })
    const particles = logoParticles(120)
    const lockWrap = el('dv-lockup-wrap', particles.cv, lock)
    const tagline = h(
      'h2',
      {},
      profile === 'user' ? 'Made with Open-Science' : 'Science, Open to All'
    )
    const chips = el(
      'dv-feature-chips',
      ...['Open source', 'Model-agnostic', 'Local-first', 'Apache-2.0'].map((label) =>
        h('span', {}, label)
      )
    )
    const url = el('dv-cta', 'aipoch.com/open-science')
    const aipoch = h('img', {
      class: 'dv-aipoch',
      src: 'brand/logos/aipoch-logo-primary.svg',
      alt: 'AIPOCH'
    })
    const root = el('dv-end', lockWrap, tagline, chips, url, aipoch)
    partsByNode.set(root, { lock, particles, tagline, chips, url, aipoch })
    update(root, { local: 0, duration: 7 })
    return root
  }

  function update(root, { local = 0, duration = 7 } = {}) {
    const parts = partsByNode.get(root)
    if (!parts) return
    // Legacy short scenes retain a complete reveal. A seven-second ending uses the original clock.
    const revealDuration = Math.min(4.1, Math.max(0.1, duration - 0.85))
    const time = (local * 4.1) / revealDuration
    const { lock, particles, tagline, chips, url, aipoch } = parts
    particles.draw(time, seg(time, 0, 1.7, linear), seg(time, 1.55, 1.95, linear))
    lock.style.opacity = seg(time, 1.55, 2.05, linear).toFixed(3)
    show(tagline, seg(time, 2, 2.6), 20)
    ;[...chips.children].forEach((chip, index) => {
      show(chip, seg(time, 2.5 + index * 0.12, 2.9 + index * 0.12, easeOutBack), 12, 0.8)
    })
    show(url, seg(time, 3.2, 3.7), 10)
    show(aipoch, seg(time, 3.6, 4.1), 10)
    const enter = seg(local, 0, 0.45)
    const exit = 1 - seg(local, duration - 0.35, duration, easeIn)
    root.style.opacity = Math.min(enter, exit).toFixed(3)
    const settle = seg(local, 0, 0.5)
    root.style.transform = `translateY(${((1 - settle) * 30).toFixed(1)}px) scale(${lerp(0.97, 1, settle).toFixed(4)})`
    root.dataset.endCardPhase =
      time < 1.55
        ? 'particles'
        : time < 2.05
          ? 'logo-handover'
          : time < 4.1
            ? 'information'
            : local >= duration - 0.35
              ? 'exit'
              : 'hold'
  }

  window.OperationEndCard = { create, update }
})()
