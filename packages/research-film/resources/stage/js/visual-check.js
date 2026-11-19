/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runs inside the standalone HTML player. */
window.__checkFilm = () => {
  const { scenes } = window.DATA.timeline
  const issues = window.__checkCaptions().slice(0, 32)
  const frames = []
  const seen = new Set()
  function report(scene, message, script) {
    const key = JSON.stringify([scene, script, message])
    if (seen.has(key) || issues.length >= 64) return
    seen.add(key)
    issues.push({ scene, ...(script ? { script } : {}), message: message.slice(0, 500) })
  }
  const overlap = (a, b) =>
    Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > 6 &&
    Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > 6
  window.__CHECK = true
  for (const scene of scenes) {
    const end = scene.dur - 0.4
    const times = new Set()
    const sample = (t) => times.add(Math.max(0, Math.min(t, end)))
    let hero = 0
    for (const p of scene.panels) {
      const reveals = [
        p.t_in,
        p.note_t,
        p.badge_t,
        p.total_t,
        p.foot_t,
        p.left?.t_in,
        p.right?.t_in,
        p.band?.t_in
      ]
      for (const items of [p.items, p.rows, p.marks, p.elements])
        for (const item of items || []) reveals.push(item.t_in)
      for (const at of reveals.filter(Number.isFinite)) {
        sample(at + 0.65)
        if (p.t_out == null) hero = Math.max(hero, at + 0.9)
      }
      if (p.t_out != null) sample(p.t_out - 0.4)
      if (p.type === 'end_card') hero = end
    }
    sample(hero)
    sample(end)
    const animations = (window.__anims || []).filter((a) => a.scene === scene.id)
    const ink = new Set()
    for (let t = 0.25; t < end; t += Math.max(0.4, end / 180)) sample(t)
    for (const t of [...times].sort((a, b) => a - b)) {
      window.__seek(scene.start + t)
      const { boxes, missingMarks, W, H } = window.__layout()
      if (missingMarks.includes(scene.id))
        report(
          scene.id,
          'The highlighted words are missing from the displayed source message. Use an exact passage or omit the highlight.'
        )
      for (const [i, box] of boxes.entries()) {
        if (!box.id.startsWith('panel:')) continue
        const [x, y, w, h] = box.rect
        if (x < 24 || y < 24 || x + w > W - 24 || y + h > H - 24)
          report(scene.id, box.id + ' extends outside the safe area.')
        for (const text of box.overflow)
          report(scene.id, box.id + ' clips the text "' + text + '".')
        for (const [j, other] of boxes.entries()) {
          if (i === j || (other.id.startsWith('panel:') && j < i)) continue
          if (overlap(box.rect, other.rect))
            report(scene.id, box.id + ' overlaps ' + other.id + '.')
        }
      }
      for (const a of animations) {
        if (
          !ink.has(a) &&
          a.box.checkVisibility({ opacityProperty: true }) &&
          a.signature().ink > 0
        )
          ink.add(a)
      }
    }
    for (const a of animations) {
      const script = a.id.slice(scene.id.length + 1)
      for (const error of a.diag.errors) report(scene.id, 'Drawing error: ' + error, script)
      for (const hit of a.diag.textHits)
        report(
          scene.id,
          'Overlapping labels at ' +
            hit.t +
            's into the scene: ' +
            hit.key +
            '. Move them into separate areas.',
          script
        )
      for (const hit of a.diag.outside)
        report(
          scene.id,
          hit.what + ' is ' + hit.by + ' px outside the canvas at ' + hit.t + 's into the scene.',
          script
        )
      for (const hit of a.diag.cardSpill)
        report(
          scene.id,
          'The label "' +
            hit.str +
            '" extends ' +
            hit.by +
            ' px past its card at ' +
            hit.t +
            's. Resize the card or use k.readoutCard.',
          script
        )
      if (!ink.has(a) && !a.diag.errors.length)
        report(scene.id, 'The animation draws nothing while its panel is visible.', script)
    }
    frames.push({
      scene: scene.id,
      time: scene.start + Math.min(Math.max(hero, scene.dur * 0.65), end)
    })
  }
  // Check the settled sign-off itself, including decoded brand artwork.
  const last = scenes.at(-1)
  window.__seek(last.start + last.dur - 0.45)
  const card = [...document.querySelectorAll('.pn-end_card')].find((el) =>
    el.checkVisibility({ opacityProperty: true })
  )
  const visible = (el) =>
    el &&
    el.checkVisibility({ opacityProperty: true }) &&
    +getComputedStyle(el).opacity >= 0.9 &&
    el.getBoundingClientRect().width > 0
  if (
    !card ||
    !['.lockup', '.display', '.cta', '.aipoch'].every((selector) => {
      const el = card.querySelector(selector)
      return visible(el) && (el.tagName !== 'IMG' || el.naturalWidth > 0)
    })
  )
    report(
      last.id,
      'The final branded end card is missing or has not fully appeared before the fade. Give it its own closing hold.'
    )
  if (window.__filmAppError || window.__filmAppUsed === false)
    issues.unshift({
      scene: scenes[0].id,
      app: true,
      message:
        'The session app could not be shown. Use a drawn illustration of the research subject.'
    })
  return { issues: issues.slice(0, 64), frames }
}
