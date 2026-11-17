/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vendored standalone browser runtime. */
/* Case-independent, clock-driven Operation Replay Video UI. This is a reconstruction, never a live app controller. */
;(() => {
  'use strict'
  const C = window.CASE_DATA || {},
    K = window.OSKit,
    { h } = K,
    W = 1920,
    H = 1080,
    FPS = 30
  const scenes = Array.isArray(C.scenes) ? C.scenes : [],
    duration =
      Number(C.duration) ||
      Math.max(0, ...scenes.map((s) => Number(s.start || 0) + Number(s.duration || s.dur || 0)))
  const render = new URLSearchParams(location.search).has('render')
  document.body.classList.add(render ? 'render' : 'preview')
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, Number(x) || 0)),
    part = (x, a, b) => clamp((x - a) / Math.max(0.0001, b - a))
  const ease = (x) => {
      x = clamp(x)
      return x * x * x * (x * (x * 6 - 15) + 10)
    },
    lerp = (a, b, q) => a + (b - a) * q
  const text = (x) => (x == null ? '' : String(x)),
    visible = (el, on) => (el.hidden = !on)
  const exportName = C.export_filename || C.science_export_name || (C.id || 'session') + '.science'
  const safeAsset = (src) =>
    typeof src === 'string' && /^data:image\/(?:png|jpeg|webp|svg\+xml);/i.test(src) ? src : ''
  const icon = (n) => K.icon(n, 'size-4')
  function nativeIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true'
    }))
      svg.setAttribute(key, value)
    for (const shape of window.LUCIDE?.[name] || []) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', shape)
      svg.append(path)
    }
    return svg
  }
  const resultBy = (id) => (C.results || []).find((x) => x.id === id),
    promptBy = (id) => (C.prompts || []).find((x) => x.id === id) || (C.prompts || [])[0]
  function sceneResults(scene) {
    const ids = [...(scene.result_ids || []), scene.result_id]
    const eventIds = (scene.events || [])
      .filter((event) => ['artifact_ready', 'open_artifact'].includes(event.kind))
      .flatMap((event) => [...(event.result_ids || []), event.result_id])
    return [...new Set([...ids, ...eventIds].filter(Boolean))].map(resultBy).filter(Boolean)
  }
  const jobBy = (id) => (C.remote_jobs || []).find((x) => (x.id || x.job_id) === id)
  function inlineNodes(value) {
    const source = text(value),
      nodes = []
    let cursor = 0
    const rx = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
    let match
    while ((match = rx.exec(source))) {
      if (match.index > cursor) nodes.push(source.slice(cursor, match.index))
      const token = match[0]
      nodes.push(
        token[0] === '`'
          ? h('code', {}, token.slice(1, -1))
          : token.startsWith('**')
            ? h('b', {}, token.slice(2, -2))
            : token.slice(1, token.indexOf(']'))
      )
      cursor = match.index + token.length
    }
    if (cursor < source.length) nodes.push(source.slice(cursor))
    return nodes
  }
  function richText(value) {
    const lines = text(value).split('\n'),
      nodes = []
    let code = null
    for (const line of lines) {
      if (line.startsWith('```')) {
        if (code) {
          nodes.push(h('pre', {}, code.join('\n')))
          code = null
        } else code = []
        continue
      }
      if (code) {
        code.push(line)
        continue
      }
      if (/^#{1,4}\s/.test(line)) {
        nodes.push(h('h3', {}, ...inlineNodes(line.replace(/^#+\s+/, ''))))
        continue
      }
      if (/^[-*]\s/.test(line)) {
        nodes.push(h('p', { class: 'dv-rich-bullet' }, '• ', ...inlineNodes(line.slice(2))))
        continue
      }
      if (line.trim()) nodes.push(h('p', {}, ...inlineNodes(line)))
    }
    if (code) nodes.push(h('pre', {}, code.join('\n')))
    return h('div', { class: 'dv-rich-text' }, ...nodes)
  }
  const normalJob = (j) =>
    j
      ? {
          ...j,
          id: j.id || j.job_id,
          provider: j.provider || j.provider_label || j.label || '',
          stdout: j.stdout ?? j.stdout_excerpt ?? '',
          stderr: j.stderr ?? j.stderr_excerpt ?? '',
          exit_code: j.exit_code ?? j.exitCode,
          output_names: j.output_names || [],
          outputs_count: j.outputs_count ?? j.output_count ?? (j.output_names || []).length,
          remote_workdir: j.remote_workdir || '',
          status_sequence: j.status_sequence ||
            j.display_status_sequence || ['submitted', 'finished']
        }
      : null
  const stage = h('div', { class: 'stage', 'data-operations': 'true', 'data-ops-version': '2' }),
    viewport = h('div', { class: 'dv-camera-viewport' }),
    bg = h('div', { class: 'dv-workspace' })
  viewport.append(bg)
  stage.append(viewport)
  document.getElementById('root').append(stage)
  const ws = K.workspace({
    compact: false,
    project: C.project_title || C.title || 'Research reproduction',
    title: C.title || 'Article reproduction',
    sections: [
      {
        label: 'Active',
        items: [{ title: C.title || 'Article reproduction', active: true, status: 'done' }]
      }
    ],
    messages: [],
    composer: false,
    panel: { tabs: [{ title: 'Notebook', icon: 'book' }], active: 0, body: '' }
  })
  bg.append(ws.el)
  const workspace = { app: ws.el, thread: ws.thread, scroller: ws.scroller, ws }
  ws.conv
    .querySelector('.osk-header')
    .after(
      h(
        'div',
        { class: 'dv-provenance' },
        C.provenance ||
          [
            C.session_number != null ? 'Session #' + C.session_number : 'Session',
            'reconstruction · time compressed'
          ].join(' ')
      )
    )
  if (C.omissions?.length) {
    const omissions = [...new Set(C.omissions)]
    ws.conv
      .querySelector('.dv-provenance')
      .append(
        h(
          'div',
          { class: 'dv-omissions', title: omissions.join('\n') },
          'Coverage: ' +
            omissions.slice(0, 2).join(' ') +
            (omissions.length > 2
              ? ' Additional limitations are listed in the source archive.'
              : '')
        )
      )
  }
  const panel = ws.panelEl,
    tabs = h('div', { class: 'dv-panel-tabs' }),
    content = h('div', { class: 'dv-panel-content' })
  panel.replaceChildren(tabs, content)
  const targets = {},
    hostLabel =
      C.environment?.host_label ||
      C.environment?.provider ||
      C.environment?.label ||
      'Remote Compute'
  const composer = window.OPSComposerV2.create({
    K,
    h,
    D: {
      prompt: promptBy()?.text || '',
      attachments: C.attachments || [],
      agentModel: C.agent_model || 'gpt-6.1-sol',
      computeStatusLabel: ['remote', 'mixed'].includes(C.environment?.mode)
        ? C.environment.initial_enabled
          ? hostLabel
          : 'None'
        : undefined
    },
    workspace,
    targets
  })
  // Case-independent Compute extension of the native composer.
  targets.compute = [...composer.controlsMenu.querySelectorAll('.oc2-menu-row')].find(
    (node) => node.querySelector('.oc2-menu-text')?.textContent === 'Compute'
  )
  const computeSwitch = h('span', { class: 'oc2-switch', 'data-on': 'false' }, h('i'))
  const computeEnable = h(
    'button',
    {
      type: 'button',
      role: 'menuitemcheckbox',
      'aria-checked': 'false',
      style: {
        border: '0',
        background: 'transparent',
        padding: '2px 4px',
        borderRadius: '6px',
        minHeight: '24px'
      }
    },
    computeSwitch
  )
  targets.computeEnable = computeEnable
  const computeMenu = h(
    'div',
    { class: 'oc2-menu oc2-compute-menu', style: { width: '288px', display: 'none' } },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          minHeight: '32px',
          padding: '2px 8px',
          borderRadius: '8px'
        }
      },
      h('span', { style: { flex: '1', fontSize: '13px' } }, hostLabel),
      computeEnable,
      icon('chevronRight')
    ),
    h('div', { class: 'oc2-separator' }),
    h(
      'div',
      { class: 'oc2-menu-row' },
      icon('settings'),
      h('span', { class: 'oc2-menu-text' }, 'Compute settings')
    )
  )
  composer.composer.querySelector('.oc2-inner').append(computeMenu)
  function computeSync(s) {
    const enabled = Boolean(s.computeEnabled),
      inner = composer.composer.querySelector('.oc2-inner')
    computeSwitch.dataset.on = String(enabled)
    computeEnable.setAttribute('aria-checked', String(enabled))
    computeEnable.setAttribute('aria-label', (enabled ? 'Disable ' : 'Enable ') + hostLabel)
    let capsule = targets.compute?.querySelector('.oc2-capsule')
    if (
      !capsule &&
      targets.compute &&
      (['remote', 'mixed'].includes(C.environment?.mode) || s.ui_operation === 'compute')
    ) {
      capsule = h('span', { class: 'oc2-capsule' }, '', icon('chevronRight'))
      targets.compute.lastElementChild.replaceWith(capsule)
    }
    if (capsule) {
      if (capsule.firstChild?.nodeType === Node.TEXT_NODE)
        capsule.firstChild.textContent = enabled ? hostLabel : 'None'
      else capsule.prepend(document.createTextNode(enabled ? hostLabel : 'None'))
    }
    // The original composer owns its regular controls states; this extension only forces the Compute operation open.
    if (s.controlsOpen) {
      composer.controlsMenu.style.display = ''
      targets.controls.dataset.hover = 'true'
      const box = inner.getBoundingClientRect(),
        a = targets.controls.getBoundingClientRect(),
        scale = inner.offsetWidth / box.width || 1
      const minLeft = -Math.max(0, inner.offsetLeft) + 4,
        maxLeft =
          workspace.ws.conv.clientWidth - inner.offsetLeft - composer.controlsMenu.offsetWidth - 4
      composer.controlsMenu.style.left =
        Math.max(minLeft, Math.min(maxLeft, (a.left - box.left) * scale)) + 'px'
      composer.controlsMenu.style.bottom = (box.bottom - a.top) * scale + 8 + 'px'
      composer.controlsMenu.style.top = 'auto'
    }
    computeMenu.style.display = s.computeMenuOpen ? '' : 'none'
    if (s.computeMenuOpen && targets.compute) {
      const b = inner.getBoundingClientRect(),
        a = targets.compute.getBoundingClientRect(),
        m = composer.controlsMenu.getBoundingClientRect(),
        scale = inner.offsetWidth / b.width || 1
      computeMenu.style.left = (m.right - b.left) * scale + 8 + 'px'
      computeMenu.style.top = (a.top - b.top) * scale - 5 + 'px'
      computeMenu.style.bottom = 'auto'
    }
  }
  const pointer = h('div', { class: 'dv-pointer' }),
    click = h('div', { class: 'dv-click' })
  pointer.innerHTML =
    '<svg viewBox="0 0 25 30"><path d="M2 1.5v23l6-6 4.7 10 4-1.9-4.6-9.3 8.4-.1Z" fill="#151515" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  targets.sessionMore = h(
    'button',
    {
      class: 'dv-session-trigger',
      type: 'button',
      'aria-label': 'Session actions',
      'data-testid': 'session-header-menu-trigger'
    },
    icon('more')
  )
  ws.conv.querySelector('.osk-header').append(targets.sessionMore)
  const editorial = h('div', { class: 'dv-editorial', hidden: true }),
    systems = h('div', { class: 'dv-system-layer' }),
    caption = h('div', { class: 'dv-caption', hidden: true })
  const brand = h(
    'div',
    { class: 'dv-brand-tag' },
    h('img', { src: 'brand/logos/open-science-symbol-black.svg' }),
    h('span', {}, h('b', {}, 'Open-Science'), ' · Use case')
  )
  stage.append(editorial, brand, systems, click, pointer, caption)
  if (C.demo)
    stage.append(
      h(
        'div',
        { class: 'dv-demo-label' },
        C.demo_label || 'Illustrative content · replace with verified article evidence'
      )
    )
  let now = 0,
    lastThreadKey = '',
    lastPanelKey = '',
    lastEditorialKey = '',
    lastSystemKey = '',
    state = {},
    history = []
  const plans = (C.plans || []).map((plan, i) => ({ ...plan, id: plan.id || 'plan-' + i }))
  const fallbackPlan = C.plan
    ? { ...C.plan, id: C.plan.id || 'primary' }
    : plans[0] || { id: 'primary', mode: 'omit', steps: [] }
  function planForScene(scene) {
    const prior = scenes
      .filter((s) => Number(s.start || 0) <= Number(scene.start || 0) && s.plan_id)
      .at(-1)
    const id = scene.plan_id || prior?.plan_id
    return (
      plans.find((p) => p.id === id) ||
      (fallbackPlan.id === id || !id ? fallbackPlan : { id, mode: 'omit', steps: [] })
    )
  }
  const usablePlan = (plan) => plan?.mode !== 'omit' && (plan?.steps || []).length > 0
  function approvalMode(plan) {
    if (!usablePlan(plan)) return 'omit'
    const requested =
      plan.approval_mode ||
      (plan.mode === 'demonstration'
        ? 'demonstration'
        : plan.approval_records_present
          ? 'archival'
          : 'omit')
    if (requested === 'archival')
      return plan.approval_records_present === true ? 'archival' : 'omit'
    return requested === 'demonstration' ? 'demonstration' : 'omit'
  }
  const durationOf = (s) => Number(s.duration ?? s.dur ?? 0),
    completionOf = (s) =>
      clamp(
        (s.kind === 'result' ? s.events?.find((e) => e.kind === 'artifact_ready')?.at : null) ??
          s.completion_at ??
          (s.kind === 'result' ? Math.min(0.25, durationOf(s) * 0.1) : durationOf(s) * 0.55),
        0,
        durationOf(s)
      )
  const failedPhase = (s) => ['error', 'failed'].includes(s.phase),
    nonzeroExit = (job) =>
      job?.exit_code != null &&
      job.exit_code !== '' &&
      Number.isFinite(Number(job.exit_code)) &&
      Number(job.exit_code) !== 0
  const failedAt = (s, local, job) =>
    local >= completionOf(s) && (failedPhase(s) || nonzeroExit(job))
  function sceneAt(t) {
    return (
      scenes.find(
        (s, i) =>
          t >= Number(s.start || 0) &&
          (i === scenes.length - 1 || t < Number(scenes[i + 1].start || 0))
      ) ||
      scenes[0] || { id: 'empty', kind: 'outro', start: 0, duration: duration }
    )
  }
  function jobStatus(s, local, job) {
    if (local >= completionOf(s)) return failedAt(s, local, job) ? 'failed' : 'finished'
    return job?.status_sequence.includes('running') ? 'running' : 'submitted'
  }
  // One semantic action clock drives the pointer, UI transitions and conversation submissions.
  const actionTargets = {
    typing_start: 'draft',
    open_attach: 'add',
    open_picker: 'addFiles',
    confirm_picker: 'picker.open',
    open_controls: 'controls',
    open_compute: 'compute',
    toggle_compute: 'computeEnable',
    toggle_auto_review: 'autoReview',
    open_send_menu: 'sendMore',
    plan_first: 'planFirst',
    submit: 'send',
    open_plan: 'openPlan',
    approve_plan: 'approvePlan',
    open_artifact: 'artifact',
    download: 'download',
    open_remote_details: 'remote.job',
    open_remote_outputs: 'remote.outputs',
    close_remote_details: 'remote.close',
    open_session_menu: 'sessionMore',
    open_export_menu: 'export.menu',
    open_export: 'export.package',
    choose_location: 'export.location',
    export_save: 'export.save'
  }
  const actionPlane = (kind) =>
    [
      'select_file',
      'confirm_picker',
      'open_remote_outputs',
      'close_remote_details',
      'open_export_menu',
      'open_export',
      'choose_location',
      'export_save'
    ].includes(kind)
      ? 'system'
      : 'workspace'
  function promptForScene(s) {
    if (s.prompt_id != null) return promptBy(s.prompt_id)
    if (s.kind === 'prompt') return promptBy()
    const index = scenes.indexOf(s),
      previous = scenes[index - 1]
    const alreadySubmitted =
      previous &&
      (previous.submit_at != null ||
        (previous.events || []).some((e) => ['submit', 'plan_first'].includes(e.kind)) ||
        (previous.messages || []).some((m) => m.role === 'user') ||
        (usablePlan(planForScene(previous)) &&
          (previous.operations || []).some((o) => o.kind === 'plan-first')))
    return s.kind === 'controls' &&
      previous &&
      ['upload', 'prompt'].includes(previous.kind) &&
      !alreadySubmitted
      ? promptBy(previous.prompt_id)
      : null
  }
  function defaultActions(s) {
    const d = durationOf(s),
      items = [],
      add = (kind, at, extra = {}) => items.push({ kind, at, ...extra })
    const prompt = promptForScene(s),
      plan = planForScene(s),
      hasPlan = usablePlan(plan),
      next = scenes[scenes.indexOf(s) + 1]
    const explicitUser = s.messages?.find((m) => m.role === 'user'),
      submitAt = s.submit_at ?? explicitUser?.at ?? d * 0.95
    if (s.kind === 'upload') {
      const picker = s.operations?.find((o) => o.kind === 'picker'),
        up = s.operations?.find((o) => o.kind === 'upload')
      const pickerStart = picker?.start ?? d * 0.16,
        pickerEnd = picker?.end ?? d * 0.7
      add('open_attach', Math.max(0.01, pickerStart * 0.42))
      add('open_picker', pickerStart)
      ;(C.attachments || []).forEach((file, i) => {
        if (file.prompt_id !== s.prompt_id) return
        add(
          'select_file',
          pickerStart +
            (pickerEnd - pickerStart) * (0.16 + (0.4 * (i + 1)) / (C.attachments.length || 1)),
          { file_index: i, target: 'picker.file:' + i }
        )
      })
      add('confirm_picker', pickerEnd)
      add('upload_ready', up?.end ?? d * 0.86, { actor: 'system' })
    }
    if (['prompt', 'upload'].includes(s.kind) && prompt) {
      const typing = s.operations?.find((o) => o.kind === 'typing')
      add('typing_start', typing?.start ?? d * (s.kind === 'upload' ? 0.76 : 0.05), {
        actor: 'user'
      })
      add('typing_end', typing?.end ?? d * (s.kind === 'upload' ? 0.9 : 0.82), { actor: 'user' })
      const controls = s.operations?.find((o) => o.kind === 'controls'),
        planFirst = s.operations?.find((o) => o.kind === 'plan-first')
      if (controls) {
        add('open_controls', controls.start)
        add('toggle_auto_review', controls.start + (controls.end - controls.start) * 0.45)
        add('close_controls', controls.end)
      }
      if (planFirst && hasPlan) {
        add('open_send_menu', planFirst.start)
        add('plan_first', s.submit_at ?? explicitUser?.at ?? planFirst.end, {
          prompt_id: prompt.id
        })
      } else if (
        s.submit_at != null ||
        explicitUser ||
        next?.kind !== 'controls' ||
        (next.prompt_id != null && next.prompt_id !== prompt.id)
      )
        add('submit', submitAt, { prompt_id: prompt.id })
    }
    if (s.kind === 'controls') {
      add('open_controls', d * 0.06)
      if (s.control === 'compute') {
        add('open_compute', d * 0.16)
        add('toggle_compute', d * 0.3)
        add('close_controls', d * 0.45)
        if (prompt) {
          add('typing_start', d * 0.47)
          add('typing_end', d * 0.82)
          add('submit', submitAt, { prompt_id: prompt.id })
        }
      } else {
        add('toggle_auto_review', d * 0.42)
        add('close_controls', d * 0.72)
        if (hasPlan) {
          add('open_send_menu', d * 0.76)
          add('plan_first', submitAt, { prompt_id: prompt?.id })
        } else if (prompt) add('submit', submitAt, { prompt_id: prompt.id })
      }
    }
    if (s.kind === 'plan' && hasPlan) {
      const lifecycle =
        plan.native_components === true && Number.isFinite(plan.lifecycle?.submitted_at)
      if (!lifecycle) add('plan_ready', d * 0.12, { actor: 'agent' })
      add('open_plan', d * 0.35)
      if (!lifecycle && approvalMode(plan) !== 'omit') add('approve_plan', d * 0.82)
    }
    if (s.kind === 'result' && sceneResults(s).length) {
      const ready = completionOf(s),
        open = Math.min(d, ready + Math.min(0.45, Math.max(0, (d - ready) * 0.35)))
      add('artifact_ready', ready, { actor: 'agent' })
      add('open_artifact', open, { result_id: s.result_id || sceneResults(s)[0]?.id })
      if (s.download === true) add('download', Math.max(open + 0.15, d * 0.8))
    }
    const job = normalJob(jobBy(s.job_id))
    if (s.kind === 'run' && job && s.details !== false) {
      const ready = completionOf(s),
        detailsAt = Math.min(
          d * 0.85,
          Math.max(Math.min(0.2, d * 0.15), ready - Math.min(0.6, d * 0.15))
        )
      add('open_remote_details', detailsAt)
      let closeAt = Math.max(d * 0.94, detailsAt + (d - detailsAt) * 0.7)
      if (s.output_menu !== false && job.output_names.length && ready < d) {
        const outputsAt = Math.min(
          d,
          Math.max(
            ready + Math.min(0.25, (d - ready) * 0.3),
            d * 0.8,
            detailsAt + Math.min(0.18, (d - detailsAt) * 0.2)
          )
        )
        add('open_remote_outputs', outputsAt)
        closeAt = Math.max(closeAt, outputsAt + (d - outputsAt) * 0.5)
      }
      add('close_remote_details', closeAt)
    }
    if (s.kind === 'export') {
      add('open_session_menu', Math.min(d * 0.18, cameraTransition(s) + Math.min(0.08, d * 0.04)))
      add('open_export_menu', d * 0.2)
      add('open_export', d * 0.3)
      add('choose_location', d * 0.47)
      add('export_save', d * 0.72)
      add('export_complete', d * 0.84, { actor: 'system' })
    }
    return items
  }
  function compileActions(s) {
    const authored = Array.isArray(s.events) ? s.events : [],
      overridden = new Set(authored.map((e) => e.kind))
    const submission = authored.find((e) => ['submit', 'plan_first'].includes(e.kind))
    if (submission) {
      overridden.add('submit')
      overridden.add('plan_first')
    }
    if (submission?.kind === 'submit' && !authored.some((e) => e.kind === 'open_send_menu'))
      overridden.add('open_send_menu')
    const defaults = defaultActions(s).filter((e) => !overridden.has(e.kind))
    if (
      submission?.kind === 'plan_first' &&
      ![...defaults, ...authored].some((e) => e.kind === 'open_send_menu')
    )
      defaults.push({
        kind: 'open_send_menu',
        at: Math.max(0, submission.at - Math.min(0.35, submission.at * 0.35))
      })
    return [...defaults, ...authored]
      .map((e, i) => {
        const actor =
          e.actor ||
          (['upload_ready', 'export_complete'].includes(e.kind)
            ? 'system'
            : ['plan_ready', 'artifact_ready'].includes(e.kind)
              ? 'agent'
              : 'user')
        const componentTarget = ['open_review', 'close_review'].includes(e.kind)
          ? 'reviewer:' + e.review_id
          : ['expand_plan', 'collapse_plan'].includes(e.kind)
            ? 'plan.expand:' + (e.plan_id || planForScene(s).id)
            : ['expand_plan_summary', 'collapse_plan_summary'].includes(e.kind)
              ? 'plan.summary:' + (e.plan_id || planForScene(s).id)
              : e.kind === 'open_artifact'
                ? 'artifact:' + (e.result_id || s.result_id || sceneResults(s)[0]?.id)
                : null
        const target =
          e.target ||
          (e.kind === 'select_file'
            ? 'picker.file:' + e.file_index
            : componentTarget || actionTargets[e.kind]) ||
          null
        return {
          ...e,
          id: e.id || s.id + '-' + e.kind + '-' + i,
          at: Number(e.at),
          actor,
          target,
          plane: e.plane || actionPlane(e.kind),
          click: actor === 'user' && (e.click ?? Boolean(target))
        }
      })
      .sort((a, b) => a.at - b.at)
  }
  const interactionTracks = scenes.map((s) => ({
    scene_id: s.id,
    start: Number(s.start || 0),
    duration: durationOf(s),
    actions: compileActions(s)
  }))
  const actionsFor = (s) =>
    interactionTracks.find((track) => track.scene_id === s.id)?.actions || []
  const actionFor = (s, kind) => actionsFor(s).find((e) => e.kind === kind)
  const actionAt = (s, kind, fallback = Infinity) => actionFor(s, kind)?.at ?? fallback
  const happened = (s, kind, local) => local >= actionAt(s, kind)
  const submissionFor = (s) => actionsFor(s).find((e) => ['submit', 'plan_first'].includes(e.kind))
  function artifactReadyAt(scene, resultId) {
    const readyActions = actionsFor(scene).filter((action) => action.kind === 'artifact_ready')
    if (!readyActions.length) return Infinity
    const matching = readyActions.filter(
      (action) =>
        action.result_id === resultId ||
        action.result_ids?.includes(resultId) ||
        (!action.result_id && !action.result_ids)
    )
    return matching.length
      ? Math.max(completionOf(scene), Math.min(...matching.map((action) => action.at)))
      : Infinity
  }
  function availableArtifacts(scene, local) {
    return sceneResults(scene).filter((result) => local >= artifactReadyAt(scene, result.id))
  }
  function selectedArtifact(scene, local) {
    const opened = actionsFor(scene)
      .filter((action) => action.kind === 'open_artifact' && action.at <= local)
      .at(-1)
    const result =
      opened && resultBy(opened.result_id || scene.result_id || sceneResults(scene)[0]?.id)
    return result && local >= artifactReadyAt(scene, result.id) ? result : null
  }
  function planLifecycleAt(plan, t = now) {
    const clock = plan?.lifecycle
    if (
      plan?.native_components !== true ||
      !usablePlan(plan) ||
      !clock ||
      !Number.isFinite(clock.submitted_at)
    )
      return null
    const actions = interactionTracks
      .filter(
        (track) => planForScene(scenes.find((scene) => scene.id === track.scene_id)).id === plan.id
      )
      .flatMap((track) =>
        track.actions.map((action) => ({ kind: action.kind, at: track.start + action.at }))
      )
    const readyCue = actions.find((action) => action.kind === 'plan_ready')?.at ?? Infinity
    const readyFallback = Number.isFinite(plan.ready_at) ? plan.ready_at : readyCue
    const submittedAt = clock.submitted_at
    const admittedAt = clock.admitted_at ?? submittedAt
    const materializedAt = clock.materialized_at ?? readyFallback
    const generationAt = clock.generation_started_at ?? materializedAt
    const approveClickAt = actions.find((action) => action.kind === 'approve_plan')?.at ?? Infinity
    const approvedAt = clock.approved_at ?? Infinity
    const approvalAt = Math.min(approveClickAt, approvedAt)
    const continuedUntil = clock.continued_until ?? approvedAt
    let phase = 'approved'
    if (t < submittedAt) phase = 'not_requested'
    else if (t < admittedAt) phase = 'preparing'
    else if (t < generationAt) phase = 'thinking'
    else if (t < materializedAt) phase = 'generating'
    else if (t < approvalAt) phase = 'awaiting_approval'
    else if (t < approvedAt) phase = 'approving'
    return {
      phase,
      submittedAt,
      admittedAt,
      generationAt,
      materializedAt,
      approvalAt,
      approvedAt,
      continuedUntil
    }
  }
  function thinkingIndicator(elapsed) {
    const indicator = h('span', { class: 'dv-native-thinking-indicator', 'aria-hidden': 'true' })
    indicator.style.setProperty('--dv-thinking-delay', -Math.max(0, elapsed) + 's')
    const dots = [
      { angle: 0, distance: 0.42, radius: 0.12, alpha: 0.9, delay: 0 },
      { angle: 72, distance: 0.36, radius: 0.08, alpha: 0.62, delay: -0.2 },
      { angle: 144, distance: 0.44, radius: 0.1, alpha: 0.78, delay: -0.4 },
      { angle: 216, distance: 0.34, radius: 0.075, alpha: 0.54, delay: -0.7 },
      { angle: 288, distance: 0.4, radius: 0.095, alpha: 0.72, delay: -0.95 }
    ]
    for (const dot of dots) {
      const node = h('span', { class: 'dv-native-thinking-dot' })
      node.style.setProperty('--os-dot-angle', dot.angle + 'deg')
      node.style.setProperty('--os-dot-distance', dot.distance)
      node.style.setProperty('--os-dot-radius', dot.radius)
      node.style.setProperty('--os-dot-alpha', dot.alpha)
      node.style.setProperty('--os-dot-delay', dot.delay + 's')
      indicator.append(node)
    }
    return indicator
  }
  const agentLoading = h('div', {
    class: 'dv-plan-agent-loading dv-agent-loading',
    'data-testid': 'plan-agent-loading',
    role: 'status',
    'aria-live': 'polite'
  })
  function planLoadingSync(plan, t) {
    agentLoading.remove()
    const activity = agentActivityAt(plan, t)
    if (!activity) return
    const indicator = thinkingIndicator(t - activity.animationStart)
    agentLoading.dataset.agentPhase = activity.phase
    if (activity.phase === 'preparing') agentLoading.replaceChildren(indicator)
    else {
      const thinking = activity.phase === 'thinking'
      const label = thinking
        ? 'Thinking'
        : activity.phase === 'interacting-with-tools'
          ? 'Interacting with tools'
          : 'Waiting for your approval'
      const totalSeconds = Math.max(0, Math.floor(t - activity.thinkingStart))
      const timer = Math.floor(totalSeconds / 60) + ':' + String(totalSeconds % 60).padStart(2, '0')
      agentLoading.replaceChildren(
        h(
          'div',
          { class: 'dv-plan-agent-loading-line' },
          indicator,
          h('span', {}, label),
          thinking
            ? h('span', { class: 'dv-plan-thinking-time', 'aria-hidden': 'true' }, timer)
            : null
        )
      )
    }
    ws.thread.append(agentLoading)
  }
  const sceneEvents = []
  scenes.forEach((s) => {
    const start = Number(s.start || 0),
      dur = durationOf(s),
      result = resultBy(s.result_id),
      job = normalJob(jobBy(s.job_id)),
      planData = planForScene(s),
      hasPlan = usablePlan(planData)
    ;(s.messages || []).forEach((m, k) =>
      sceneEvents.push({
        id: m.id || s.id + '-message-' + k,
        kind: 'message',
        role: m.role || 'agent',
        label: m.label,
        text: text(m.text),
        source_ref: m.source_ref,
        at: start + Number(m.at || 0),
        scene: s,
        typing: m.role !== 'user',
        reveal_duration: m.reveal_duration
      })
    )
    const submission = submissionFor(s),
      submittedPrompt = promptForScene(s)
    if (submission && submittedPrompt && !s.messages?.some((m) => m.role === 'user'))
      sceneEvents.push({
        id: s.id + '-prompt',
        kind: 'message',
        role: 'user',
        text: text(submittedPrompt.text),
        source_ref: submittedPrompt.source_ref,
        at: start + submission.at,
        scene: s,
        prompt_id: submittedPrompt.id,
        typing: false
      })
    if (s.kind === 'plan' && hasPlan) {
      const lifecycle = planLifecycleAt(planData, 0)
      sceneEvents.push({
        id: s.id + '-plan',
        kind: 'plan',
        plan_id: planData.id,
        approval_mode: approvalMode(planData),
        text: planData.title || 'Session Plan',
        at: lifecycle
          ? lifecycle.generationAt
          : Number.isFinite(planData.ready_at)
            ? planData.ready_at
            : start + actionAt(s, 'plan_ready'),
        done: lifecycle ? lifecycle.approvedAt : start + actionAt(s, 'approve_plan'),
        scene: s
      })
    }
    if (s.kind === 'run')
      sceneEvents.push({
        id: s.id + '-run',
        kind: job ? 'remote' : 'run',
        text: job?.title || s.title || result?.name || 'Analysis',
        job,
        result,
        at: start + Math.min(0.12, dur * 0.05),
        done: start + completionOf(s),
        scene: s
      })
    if (s.kind === 'run') {
      const ready = Math.min(...sceneResults(s).map((item) => artifactReadyAt(s, item.id)))
      if (Number.isFinite(ready))
        sceneEvents.push({ id: s.id + '-artifacts', kind: 'artifact', at: start + ready, scene: s })
    }
    if (s.kind === 'result')
      sceneEvents.push({
        id: s.id + '-result',
        kind: 'result',
        text: s.message || result?.caption || '',
        at: start + completionOf(s),
        scene: s
      })
  })
  for (const review of C.reviews || []) {
    sceneEvents.push({
      id: 'review-' + review.id,
      kind: 'review',
      review,
      at: Number(review.started_at),
      done: Number(review.completed_at),
      source_ref: review.source_refs?.[0]
    })
  }
  sceneEvents.sort((a, b) => a.at - b.at)
  const agentRunWindows =
    C.show_agent_thinking === true
      ? interactionTracks
          .flatMap((track) =>
            track.actions
              .filter((action) => ['submit', 'plan_first'].includes(action.kind))
              .map((action) => ({ start: track.start + action.at }))
          )
          .sort((first, second) => first.start - second.start)
          .map((run, index, runs) => {
            const nextStart = runs[index + 1]?.start ?? Infinity
            const terminal = sceneEvents
              .filter(
                (event) =>
                  event.kind === 'message' &&
                  ['agent', 'assistant'].includes(event.role) &&
                  event.at >= run.start &&
                  event.at < nextStart
              )
              .at(-1)
            return {
              start: run.start,
              end: terminal
                ? Math.min(nextStart, terminal.at + (terminal.reveal_duration ?? 0.16))
                : run.start
            }
          })
      : []
  function agentActivityAt(plan, t) {
    const general = C.show_agent_thinking === true
    if (general && ['opening', 'paper', 'export', 'outro'].includes(sceneAt(t).kind)) return null
    const lifecycle = planLifecycleAt(plan, t)
    const run = agentRunWindows.find((window) => t >= window.start && t < window.end)
    const continued = lifecycle?.phase === 'approved' && t < lifecycle.continuedUntil
    const planPhases = {
      preparing: 'preparing',
      thinking: 'thinking',
      generating: 'interacting-with-tools',
      awaiting_approval: 'waiting-for-approval',
      approving: 'waiting-for-approval'
    }
    const planPhase = planPhases[lifecycle?.phase]
    if (planPhase && (planPhase !== 'thinking' || !general || !run))
      return {
        phase: planPhase,
        start: run?.start ?? lifecycle.submittedAt,
        end: run?.end ?? lifecycle.continuedUntil,
        thinkingStart: lifecycle.admittedAt,
        animationStart: lifecycle.submittedAt,
        running: planPhase !== 'waiting-for-approval'
      }
    if (!general || !run)
      return continued
        ? {
            phase: 'thinking',
            start: lifecycle.submittedAt,
            end: lifecycle.continuedUntil,
            thinkingStart: lifecycle.approvedAt,
            animationStart: lifecycle.approvedAt,
            running: true
          }
        : null
    const tools = sceneEvents.filter(
      (event) =>
        ['run', 'remote'].includes(event.kind) && event.at >= run.start && event.at < run.end
    )
    const toolActive = tools.some((event) => t >= event.at && t < event.done)
    const latestToolUpdate = Math.max(
      run.start,
      ...tools.flatMap((event) => [event.at, event.done]).filter((update) => update <= t)
    )
    const approvedAt = lifecycle?.approvedAt <= t ? lifecycle.approvedAt : run.start
    const admittedAt = lifecycle?.phase === 'thinking' ? lifecycle.admittedAt : run.start
    return {
      phase: toolActive ? 'interacting-with-tools' : 'thinking',
      start: run.start,
      end: run.end,
      thinkingStart: Math.max(latestToolUpdate, approvedAt, admittedAt),
      animationStart: Math.max(run.start, approvedAt),
      running: true
    }
  }
  function latestComponentAction(kinds, componentId, field) {
    return interactionTracks
      .flatMap((track) =>
        track.actions.map((action) => ({
          ...action,
          absoluteAt: track.start + action.at,
          scene: scenes.find((scene) => scene.id === track.scene_id)
        }))
      )
      .filter(
        (action) =>
          kinds.includes(action.kind) &&
          action.absoluteAt <= now &&
          (field === 'plan_id'
            ? (action.plan_id || planForScene(action.scene).id) === componentId
            : action[field] === componentId)
      )
      .at(-1)
  }
  function messageNode(e, t) {
    if (e.role === 'user') {
      const node = K.message({ i: e.id, role: 'user', md: '' })
      node
        .querySelector('[data-slot="user-message-bubble"]')
        .replaceChildren(h('div', { class: 'dv-message' }, e.text))
      if (e.prompt_id)
        node.append(
          h(
            'div',
            { class: 'dv-user-files' },
            ...(C.attachments || [])
              .filter((file) => file.prompt_id === e.prompt_id)
              .map((f) => h('span', { class: 'dv-file-chip' }, f.name))
          )
        )
      const lifecycle = planLifecycleAt(planForScene(e.scene), t)
      if (lifecycle?.phase === 'preparing' && Math.abs(e.at - lifecycle.submittedAt) < 0.001)
        node.append(
          h(
            'span',
            { class: 'dv-user-sending', role: 'status' },
            nativeIcon('loader-circle'),
            'Sending…'
          )
        )
      return node
    }
    if (e.role === 'system')
      return h(
        'div',
        { class: 'dv-application-event' },
        h('small', {}, e.label || 'Application event'),
        h('div', {}, e.text)
      )
    if (C.conversation_mode === 'full') {
      const node = K.message({ i: e.id, role: 'agent', md: e.text })
      node.classList.add('dv-full-message')
      return node
    }
    const age = t - e.at,
      q = e.typing ? part(age, 0, Math.min(0.75, Math.max(0.2, e.text.length / 250))) : 1
    const body = richText(e.text)
    if (q < 1) {
      let remaining = Math.floor(body.textContent.length * q)
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const length = node.textContent.length
        node.textContent = node.textContent.slice(0, remaining)
        remaining = Math.max(0, remaining - length)
      }
    }
    return h('div', { class: 'dv-message' }, body)
  }
  function remoteCard(job, status) {
    return h(
      'div',
      { class: 'dv-remote-card', 'data-status': status, 'data-job-id': job.id },
      icon('zap'),
      h('span', { class: 'dv-remote-host' }, job.provider),
      h('span', { class: 'dv-remote-title' }, job.title),
      h('span', { class: 'dv-remote-status' }, '— ' + status),
      h('span', { class: 'dv-remote-chevron' }, '›')
    )
  }
  function artifactFilename(name) {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    return h(
      'span',
      { class: 'adn-filename', title: name },
      h('span', { class: 'adn-stem' }, stem),
      h('span', { class: 'adn-extension' }, extension)
    )
  }
  function artifactIcon(result, size = 14) {
    const graphic = nativeIcon(
      result.type === 'image' ? 'image' : result.type === 'package' ? 'file-archive' : 'file'
    )
    graphic.setAttribute('width', size)
    graphic.setAttribute('height', size)
    graphic.setAttribute('stroke-width', 1.75)
    return graphic
  }
  function artifactBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB'
    return (bytes / 1048576).toFixed(1) + ' MB'
  }
  function resultCards(results) {
    if (!results.length) return null
    return h(
      'section',
      { class: 'adn-gallery' },
      h('div', { class: 'adn-generated-label' }, 'GENERATED · ' + results.length),
      h(
        'div',
        { class: 'adn-grid' },
        ...results.map((result) => {
          const name = result.name || result.id
          const extension = name.includes('.') ? name.split('.').at(-1).toUpperCase() : ''
          return h(
            'button',
            {
              class: 'adn-card dv-result-card',
              type: 'button',
              title: name,
              'aria-label': 'Preview generated file ' + name,
              'data-result-id': result.id,
              'data-file-name': name,
              'data-file-key': result.id,
              'data-active': 'false'
            },
            h(
              'div',
              { class: 'adn-card-preview' },
              result.type === 'image' && result.src
                ? h('img', {
                    src: safeAsset(result.src),
                    alt: 'Preview of ' + name,
                    draggable: 'false'
                  })
                : h(
                    'div',
                    { class: 'adn-type-preview' },
                    artifactIcon(result, 20),
                    h('span', {}, extension)
                  ),
              h('span', { class: 'adn-open', 'aria-hidden': 'true' }, nativeIcon('arrow-up-right'))
            ),
            h(
              'div',
              { class: 'adn-card-footer' },
              artifactFilename(name),
              h('span', { class: 'adn-card-size' }, artifactBytes(result.bytes))
            )
          )
        })
      )
    )
  }
  function artifactHeader(result) {
    const name = result.name || result.id
    const href = safeAsset(result.src || result.href)
    return h(
      'header',
      { class: 'adn-header', 'data-testid': 'preview-card-header' },
      h('span', { class: 'adn-header-name' }, artifactIcon(result), artifactFilename(name)),
      href && result.downloadable !== false
        ? h(
            'a',
            {
              class: 'adn-icon-button dv-file-download',
              href,
              download: name,
              title: 'Download',
              'aria-label': 'Download ' + name
            },
            icon('download')
          )
        : null,
      h(
        'button',
        {
          class: 'adn-icon-button',
          type: 'button',
          title: 'Open full screen preview',
          'aria-label': 'Open full screen preview of ' + name
        },
        nativeIcon('maximize-2')
      ),
      h(
        'button',
        {
          class: 'adn-icon-button',
          type: 'button',
          title: 'Close preview of ' + name,
          'aria-label': 'Close preview of ' + name
        },
        icon('x')
      )
    )
  }
  function artifactTabs(result) {
    const tab = (name, selected, file) =>
      h(
        'div',
        { class: 'adn-tab', 'data-active': String(selected) },
        h(
          'button',
          {
            class: 'adn-tab-main',
            type: 'button',
            role: 'tab',
            'aria-selected': String(selected),
            title: name
          },
          file ? artifactIcon(file) : icon('book'),
          file ? artifactFilename(name) : name
        ),
        h(
          'button',
          { class: 'adn-tab-close', type: 'button', 'aria-label': 'Close preview of ' + name },
          icon('x')
        )
      )
    return [tab('Notebook', false), tab(result.name || result.id, true, result)]
  }
  function nativePlanCard(planData) {
    if (planData.native_components === true) return sourcePlanCard(planData)
    const steps = planData.steps || []
    const feasibility = planData.feasibility || {}
    const stepRows = steps
      .slice(0, 5)
      .map((step, i) =>
        h(
          'li',
          {},
          h('span', { class: 'dv-plan-call-number' }, i + 1 + '.'),
          h('span', { class: 'dv-plan-call-step-title' }, step.title),
          h('span', { class: 'dv-plan-call-chevron' }, '›')
        )
      )
    const confidence = feasibility.confidence
      ? h('span', { class: 'dv-plan-call-confidence' }, feasibility.confidence + ' confidence')
      : null
    const rationale = feasibility.rationale ? h('p', {}, feasibility.rationale) : null
    const feasibilityRow =
      confidence || rationale
        ? h('div', { class: 'dv-plan-call-feasibility' }, confidence, rationale)
        : null
    return h(
      'div',
      { class: 'dv-plan-call', role: 'region', 'aria-label': 'Plan call record' },
      h(
        'div',
        { class: 'dv-plan-call-header' },
        icon('check'),
        h('span', {}, 'Created execution Plan'),
        h(
          'span',
          { class: 'dv-plan-call-count' },
          steps.length + (steps.length === 1 ? ' step' : ' steps')
        )
      ),
      h(
        'div',
        { class: 'dv-plan-call-body' },
        h(
          'div',
          { class: 'dv-plan-call-summary' },
          planData.task_summary || planData.title || 'Analysis plan'
        ),
        h('ol', { class: 'dv-plan-call-steps' }, ...stepRows),
        steps.length > 5
          ? h('div', { class: 'dv-plan-call-more' }, '+ ' + (steps.length - 5) + ' more steps')
          : null,
        feasibilityRow
      )
    )
  }
  function sourcePlanCard(planData) {
    const lifecycle = planLifecycleAt(planData)
    const creating = lifecycle?.phase === 'generating'
    const expanded =
      latestComponentAction(['expand_plan', 'collapse_plan'], planData.id, 'plan_id')?.kind ===
      'expand_plan'
    const summaryAction = latestComponentAction(
      ['expand_plan', 'collapse_plan', 'expand_plan_summary', 'collapse_plan_summary'],
      planData.id,
      'plan_id'
    )
    const summaryExpanded = ['expand_plan', 'expand_plan_summary'].includes(summaryAction?.kind)
    const everythingExpanded = expanded && summaryExpanded
    const steps = planData.steps || []
    const confidence = planData.feasibility?.confidence
    const summary = h(
      'p',
      {
        class: 'dv-native-plan-summary' + (summaryExpanded ? ' expanded' : ''),
        'data-testid': 'plan-task-summary'
      },
      planData.task_summary || planData.title || 'Analysis plan'
    )
    return h(
      'section',
      {
        class: 'dv-native-plan-call',
        'data-testid': 'plan-call-record',
        'data-plan-id': planData.id,
        'data-plan-phase': lifecycle?.phase,
        'aria-label': 'Plan call record'
      },
      h(
        'div',
        { class: 'dv-native-plan-call-header' },
        h(
          'span',
          {
            class: 'dv-native-plan-status',
            'data-generation-started-at': creating ? lifecycle.generationAt : null
          },
          creating ? nativeIcon('loader-circle') : icon('check')
        ),
        h('span', {}, creating ? 'Creating execution Plan' : 'Created execution Plan'),
        h(
          'span',
          { class: 'dv-native-plan-count' },
          steps.length + (steps.length === 1 ? ' step' : ' steps')
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'dv-native-plan-expand',
            'data-target': 'plan.expand:' + planData.id,
            'data-testid': 'plan-expand-all',
            'aria-expanded': String(everythingExpanded)
          },
          everythingExpanded ? 'Collapse all' : 'Expand all'
        )
      ),
      h(
        'div',
        { class: 'dv-native-plan-call-body' },
        h(
          'div',
          { class: 'dv-native-plan-summary-group' },
          summary,
          h(
            'button',
            {
              type: 'button',
              class: 'dv-native-plan-summary-toggle',
              'data-target': 'plan.summary:' + planData.id,
              'aria-expanded': String(summaryExpanded)
            },
            summaryExpanded ? 'Show less' : 'Show full task'
          )
        ),
        h(
          'ol',
          { class: 'dv-native-plan-steps' },
          ...steps
            .slice(0, expanded ? steps.length : 5)
            .map((step, index) =>
              h(
                'li',
                {},
                h('span', { class: 'dv-native-plan-number' }, index + 1 + '.'),
                h(
                  'div',
                  { class: 'dv-native-plan-step-body' },
                  h(
                    'button',
                    { type: 'button', 'aria-expanded': String(expanded) },
                    h('span', {}, step.title),
                    h(
                      'span',
                      { class: 'dv-native-plan-step-chevron' + (expanded ? ' expanded' : '') },
                      icon('chevronRight')
                    )
                  ),
                  expanded ? h('p', {}, step.detail || step.description || '') : null
                )
              )
            )
        ),
        !expanded && steps.length > 5
          ? h('div', { class: 'dv-native-plan-more' }, '+ ' + (steps.length - 5) + ' more steps')
          : null,
        h(
          'div',
          { class: 'dv-native-plan-feasibility' },
          confidence
            ? h('span', { class: 'dv-native-plan-confidence' }, confidence + ' confidence')
            : null,
          h('span', {}, planData.feasibility?.rationale || '')
        )
      )
    )
  }
  function reviewCard(review, t) {
    const complete = t >= Number(review.completed_at)
    if (!complete) {
      const dots = [0, 72, 144, 216, 288].map((angle, index) =>
        h('span', {
          class: 'dv-review-thinking-dot',
          style: {
            transform:
              'rotate(' + (angle + t * 80) + 'deg) translateX(' + (index % 2 ? 3.6 : 4.2) + 'px)',
            opacity: [0.9, 0.62, 0.78, 0.54, 0.72][index]
          }
        })
      )
      return h(
        'div',
        {
          class: 'dv-review-running',
          'data-testid': 'reviewer-running-state',
          'data-review-id': review.id,
          role: 'status'
        },
        h('span', { class: 'dv-review-thinking', 'aria-hidden': 'true' }, ...dots),
        h('span', {}, 'Reviewing...')
      )
    }
    const checks = review.findings || []
    const flagged = checks.filter((check) => ['warn', 'fail'].includes(check.status)).length
    const expanded =
      latestComponentAction(['open_review', 'close_review'], review.id, 'review_id')?.kind ===
      'open_review'
    const summary = flagged
      ? flagged + (flagged === 1 ? ' finding' : ' findings')
      : checks.length
        ? 'No issues found'
        : 'No checkable claims'
    return h(
      'div',
      {
        class: 'dv-review-card',
        'data-testid': 'reviewer-card',
        'data-review-id': review.id,
        'data-review-anchor-message-id': review.anchor_message_id
      },
      h(
        'button',
        {
          class: 'dv-review-summary',
          type: 'button',
          'aria-expanded': String(expanded),
          'data-target': 'reviewer:' + review.id
        },
        h(
          'span',
          { class: 'dv-review-status-icon' + (flagged ? ' flagged' : '') },
          nativeIcon(flagged ? 'triangle-alert' : 'shield-check')
        ),
        h('span', { class: 'dv-review-label' }, 'Reviewer'),
        h('span', { class: 'dv-review-dot' }, '·'),
        h('span', { class: 'dv-review-outcome' + (flagged ? ' flagged' : '') }, summary),
        checks.length ? h('span', { class: 'dv-review-dot' }, '·') : null,
        checks.length
          ? h('span', {}, checks.length + (checks.length === 1 ? ' check' : ' checks'))
          : null,
        checks.length
          ? h(
              'span',
              { class: 'dv-review-chevron' },
              icon(expanded ? 'chevronDown' : 'chevronRight')
            )
          : null
      ),
      expanded
        ? h(
            'div',
            { class: 'dv-review-checks' },
            ...checks.map((check) =>
              h(
                'div',
                { class: 'dv-review-check', 'data-testid': 'reviewer-check-card' },
                h(
                  'div',
                  { class: 'dv-review-check-top' },
                  h('span', { class: 'dv-review-check-badge ' + check.status }, check.status),
                  h('span', { class: 'dv-review-check-claim' }, check.claim)
                ),
                check.evidence
                  ? h('p', { class: 'dv-review-check-evidence' }, check.evidence)
                  : null,
                h(
                  'div',
                  { class: 'dv-review-check-footer' },
                  review.model ? h('span', { class: 'dv-review-model' }, review.model) : h('span'),
                  h('button', { type: 'button' }, 'Go to transcript')
                )
              )
            )
          )
        : null
    )
  }
  function renderHistory(t) {
    const lifecycleKey = [fallbackPlan, ...plans]
      .map((plan) => plan.id + ':' + (planLifecycleAt(plan, t)?.phase || ''))
      .join('|')
    const shown = sceneEvents.filter((e) => e.at <= t)
    const galleryKey = shown
      .filter((event) => ['result', 'artifact'].includes(event.kind))
      .map((event) =>
        availableArtifacts(event.scene, t - Number(event.scene.start || 0))
          .map((result) => result.id)
          .join(',')
      )
      .join('|')
    const key =
      shown
        .map(
          (e) =>
            e.id +
            '|' +
            (e.kind === 'message' && e.typing && C.conversation_mode !== 'full'
              ? Math.floor(part(t - e.at, 0, 0.75) * 100)
              : t >= e.done
                ? 'done'
                : 'active') +
            '|' +
            (e.kind === 'review'
              ? latestComponentAction(['open_review', 'close_review'], e.review.id, 'review_id')
                  ?.id || ''
              : e.kind === 'plan'
                ? latestComponentAction(
                    [
                      'expand_plan',
                      'collapse_plan',
                      'expand_plan_summary',
                      'collapse_plan_summary'
                    ],
                    e.plan_id,
                    'plan_id'
                  )?.id || ''
                : '')
        )
        .join(';') +
      '|' +
      lifecycleKey +
      '|' +
      galleryKey
    if (key !== lastThreadKey) {
      lastThreadKey = key
      ws.thread.replaceChildren(
        ...shown.map((e) => {
          let body
          if (e.kind === 'message') body = messageNode(e, t)
          else if (e.kind === 'review') body = reviewCard(e.review, t)
          else if (e.kind === 'remote')
            body = remoteCard(e.job, jobStatus(e.scene, t - e.scene.start, e.job))
          else if (e.kind === 'run') {
            const failed = failedAt(e.scene, t - e.scene.start),
              done = t >= e.done
            body = h(
              'div',
              {
                class: 'dv-tool-card',
                'data-status': failed ? 'failed' : done ? 'completed' : 'running'
              },
              icon(failed ? 'x' : done ? 'check' : 'book'),
              h('span', {}, e.text),
              h(
                'span',
                { class: 'dv-status' },
                failed ? 'Failed' : done ? 'Completed' : 'Executing…'
              )
            )
          } else if (e.kind === 'plan') {
            const planData = planForScene(e.scene)
            const approved = e.approval_mode !== 'omit' && t >= e.done
            body =
              planData.native_card === true
                ? nativePlanCard(planData)
                : h(
                    'div',
                    { class: 'dv-tool-card', 'data-status': approved ? 'completed' : 'ready' },
                    icon('files'),
                    h('span', {}, e.text),
                    h(
                      'span',
                      { class: 'dv-status' },
                      approved
                        ? e.approval_mode === 'demonstration'
                          ? 'Approved · demonstration'
                          : 'Approved'
                        : 'Plan ready'
                    )
                  )
          } else
            body = h(
              'div',
              {},
              e.text ? h('div', { class: 'dv-message' }, e.text) : null,
              resultCards(availableArtifacts(e.scene, t - Number(e.scene.start || 0)))
            )
          return h(
            'div',
            { class: 'dv-history-entry', 'data-history-id': e.id, 'data-history-at': e.at },
            h('div', {}, body)
          )
        })
      )
    }
    for (const card of ws.thread.querySelectorAll('.dv-native-plan-call')) {
      const summary = card.querySelector('.dv-native-plan-summary')
      const lineHeight = Number.parseFloat(getComputedStyle(summary).lineHeight)
      card.querySelector('.dv-native-plan-summary-toggle').hidden =
        summary.scrollHeight <= lineHeight * 3 + 1
    }
    for (const summary of ws.thread.querySelectorAll('.dv-native-plan-summary')) {
      const toggle = summary.parentElement.querySelector('.dv-native-plan-summary-toggle')
      toggle.hidden =
        !summary.classList.contains('expanded') && summary.scrollHeight <= summary.clientHeight + 1
    }
    const entries = [...ws.thread.children].filter((entry) =>
      entry.classList.contains('dv-history-entry')
    )
    for (const [index, entry] of entries.entries()) {
      const event = shown[index],
        age = t - event.at
      const reveal = C.conversation_mode === 'full' ? (event.reveal_duration ?? 0.16) : 0.25
      entry.style.height = entry.firstChild.scrollHeight * ease(part(age, 0, reveal)) + 'px'
      entry.style.opacity = String(part(age, 0, Math.min(0.15, reveal)))
    }
    for (const indicator of ws.thread.querySelectorAll('.dv-review-thinking')) {
      ;[...indicator.children].forEach((dot, index) => {
        dot.style.transform =
          'rotate(' + (index * 72 + t * 80) + 'deg) translateX(' + (index % 2 ? 3.6 : 4.2) + 'px)'
      })
    }
    for (const running of ws.thread.querySelectorAll('.dv-review-running')) {
      running.querySelectorAll('.dv-review-thinking-dot').forEach((dot, index) => {
        dot.style.transform =
          'rotate(' + (index * 72 + t * 80) + 'deg) translateX(' + (index % 2 ? 3.6 : 4.2) + 'px)'
      })
    }
    for (const status of ws.thread.querySelectorAll('[data-generation-started-at]'))
      status.firstElementChild.style.transform =
        'rotate(' + (t - Number(status.dataset.generationStartedAt)) * 360 + 'deg)'
    for (const sending of ws.thread.querySelectorAll('.dv-user-sending svg'))
      sending.style.transform = 'rotate(' + t * 360 + 'deg)'
    const currentScene = sceneAt(t),
      local = t - Number(currentScene.start || 0),
      preview = panelProjection(currentScene, local)
    const hovered = actionsFor(currentScene).findLast(
      (action) => action.kind === 'open_artifact' && local >= action.at - 0.25 && local <= action.at
    )
    const hoveredId =
      hovered && (hovered.result_id || currentScene.result_id || sceneResults(currentScene)[0]?.id)
    for (const card of ws.thread.querySelectorAll('.adn-card')) {
      card.dataset.active = String(
        preview.mode === 'artifact' && card.dataset.resultId === preview.result.id
      )
      card.dataset.hover = String(card.dataset.resultId === hoveredId)
    }
    history = shown.map((e) => ({
      id: e.id,
      kind: e.kind,
      role: e.role || 'agent',
      prompt_id: e.prompt_id || null,
      at: e.at,
      source_ref: e.source_ref,
      status:
        e.kind === 'remote'
          ? jobStatus(e.scene, t - e.scene.start, e.job)
          : e.kind === 'plan'
            ? planLifecycleAt(planForScene(e.scene), t)?.phase ||
              (e.approval_mode === 'omit'
                ? 'ready'
                : t >= e.done
                  ? 'approved'
                  : 'awaiting_approval')
            : e.kind === 'run' && failedAt(e.scene, t - e.scene.start)
              ? 'failed'
              : e.done == null
                ? 'visible'
                : t >= e.done
                  ? 'completed'
                  : 'running'
    }))
  }
  function notebook(result, s, local) {
    const lang = (result?.language || s.language || 'python').toLowerCase(),
      job = normalJob(jobBy(s.job_id)),
      done = local >= completionOf(s),
      failed = failedAt(s, local, job)
    const label = job
      ? 'Agent SDK'
      : lang === 'r'
        ? 'R'
        : lang === 'bash'
          ? 'Bash'
          : lang === 'javascript'
            ? 'Agent SDK'
            : 'Python'
    const runtime = C.environment?.label || ''
    const code = text(result?.code || s.code),
      output = text(
        failed
          ? result?.stderr || s.stderr || job?.stderr || result?.stdout || s.stdout || job?.stdout
          : result?.stdout || s.stdout || job?.stdout
      )
    return [
      h(
        'div',
        { class: 'dv-notebook-agent' },
        'Agent',
        h('span', {}, C.agent_name || 'Main Agent')
      ),
      h(
        'div',
        { class: 'dv-notebook-language' },
        ...['Python', 'R', 'Agent SDK'].map((x) => h(x === label ? 'b' : 'span', {}, x)),
        h('span', { class: 'dv-runtime' }, runtime)
      ),
      h(
        'div',
        { class: 'dv-notebook-scroll' },
        h(
          'div',
          { class: 'dv-cell-head' },
          h('span', { class: 'dv-cell-chip' }, job ? 'JavaScript · Remote Compute' : label),
          h('span', {}, result?.name || s.title || ''),
          h(
            'span',
            { class: 'dv-cell-state' },
            failed
              ? 'Recorded error'
              : done
                ? job
                  ? 'Remote result returned'
                  : 'Completed'
                : job
                  ? 'Awaiting remote result'
                  : 'Executing…'
          )
        ),
        h('pre', { class: 'dv-code' }, code),
        h(
          'div',
          { class: 'dv-output-label' },
          job
            ? failed && (result?.stderr || s.stderr || job.stderr)
              ? '▾ returned remote stderr'
              : '▾ returned remote stdout'
            : '▾ output',
          h('span', {}, failed ? 'Failed' : done ? '✓ completed' : 'Awaiting result')
        ),
        h(
          'pre',
          { class: 'dv-output', 'data-status': failed ? 'error' : done ? 'completed' : 'pending' },
          done ? output : ''
        ),
        h(
          'div',
          { class: 'dv-source' },
          (result?.evidence_refs || s.source_refs || [])
            .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
            .join(' · ')
        )
      )
    ]
  }
  function resultView(r) {
    if (!r) return [h('div', { class: 'dv-report' }, '')]
    const head = h(
      'div',
      { class: 'dv-native-filehead' },
      icon('file'),
      h('span', {}, r.name || r.id),
      h('span', { class: 'dv-file-download', 'aria-label': 'Download file' }, icon('download')),
      icon('more'),
      icon('x')
    )
    if (r.type === 'image')
      return [
        artifactHeader(r),
        h(
          'div',
          { class: 'adn-image-body dv-image-body' },
          h('img', {
            class: 'adn-original-image',
            src: safeAsset(r.src),
            alt: r.name || r.id,
            draggable: 'false'
          })
        )
      ]
    if (r.type === 'table' && Array.isArray(r.rows))
      return [
        head,
        h(
          'div',
          { class: 'dv-report', style: { padding: '12px' } },
          h(
            'table',
            { class: 'dv-table' },
            r.columns
              ? h('thead', {}, h('tr', {}, ...r.columns.map((x) => h('th', {}, text(x)))))
              : null,
            h(
              'tbody',
              {},
              ...r.rows
                .slice(0, 20)
                .map((row) =>
                  h(
                    'tr',
                    {},
                    ...(Array.isArray(row) ? row : Object.values(row)).map((x) =>
                      h('td', {}, text(x))
                    )
                  )
                )
            )
          )
        )
      ]
    if (r.type === 'package')
      return [
        head,
        h(
          'div',
          { class: 'dv-package' },
          icon('file'),
          h('b', {}, r.name || r.id),
          h('span', {}, r.preview_message || 'Preview unavailable'),
          h('small', {}, 'This file type is not supported for preview'),
          r.src
            ? h(
                'a',
                { class: 'dv-download', href: safeAsset(r.src), download: r.name || '' },
                icon('download'),
                'Download'
              )
            : null
        )
      ]
    return [head, h('div', { class: 'dv-report' }, richText(r.text || r.caption || ''))]
  }
  function planView(s, local) {
    const planData = planForScene(s),
      planMode = planData.mode || 'omit',
      steps = planData.steps || [],
      phaseNames = [...new Set(steps.map((x) => x.phase || 'Analysis workflow'))]
    if (planData.native_components === true) return nativePlanView(planData, s, local)
    return [
      h(
        'div',
        { class: 'dv-plan-header' },
        planData.filename || 'Session Plan',
        h('span', {}, icon('download'))
      ),
      h(
        'div',
        { class: 'dv-plan-doc' },
        h('div', { class: 'dv-plan-title' }, planData.title || 'Analysis plan'),
        h(
          'div',
          { class: 'dv-plan-mode' },
          planMode === 'archival'
            ? 'Recorded Session Plan'
            : 'Demonstration plan · not an archival approval record'
        ),
        ...phaseNames.map((name, i) =>
          h(
            'section',
            { class: 'dv-plan-phase' },
            h('small', {}, 'PHASE ' + (i + 1)),
            h('h3', {}, name),
            ...steps
              .filter((x) => (x.phase || 'Analysis workflow') === name)
              .map((step) => {
                const done = Number.isFinite(step.completed_at) && now >= step.completed_at
                return h(
                  'div',
                  { class: 'dv-plan-step' },
                  h('span', { class: 'dv-plan-mark' + (done ? ' done' : '') }, done ? '✓' : ''),
                  h('div', {}, h('b', {}, step.title), step.detail ? h('p', {}, step.detail) : null)
                )
              })
          )
        )
      )
    ]
  }
  function nativePlanView(planData, s, local) {
    const steps = planData.steps || []
    const phaseNames = [...new Set(steps.map((step) => step.phase || 'Analysis workflow'))]
    const lifecycle = planLifecycleAt(planData)
    const pending =
      approvalMode(planData) !== 'omit' &&
      (lifecycle
        ? ['awaiting_approval', 'approving'].includes(lifecycle.phase)
        : !happened(s, 'approve_plan', local))
    const summary = planData.task_summary || planData.title || 'Analysis plan'
    return [
      h(
        'header',
        { class: 'dv-native-plan-header' },
        h('span', {}, planData.filename || 'Session Plan'),
        h(
          'div',
          {},
          h(
            'button',
            { type: 'button', 'aria-label': 'Download Plan' },
            icon('download'),
            'Download'
          ),
          pending
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'dv-native-plan-outline',
                  disabled: lifecycle?.phase === 'approving'
                },
                'Dismiss'
              )
            : null,
          pending
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'dv-native-plan-primary',
                  'data-target': 'plan.panelApprove',
                  disabled: lifecycle?.phase === 'approving'
                },
                'Approve'
              )
            : null,
          h(
            'button',
            { type: 'button', 'aria-label': 'Enter full screen' },
            nativeIcon('maximize-2')
          )
        )
      ),
      h(
        'div',
        { class: 'dv-native-plan-document' },
        h('h1', { class: 'dv-plan-title' }, summary),
        h(
          'p',
          { class: 'dv-native-plan-phase-order' },
          'Complete ' +
            phaseNames.length +
            (phaseNames.length === 1 ? ' phase' : ' phases') +
            ' in order. Delegations within a phase may run in parallel.'
        ),
        ...phaseNames.map((phase, phaseIndex) => {
          const phaseSteps = steps.filter((step) => (step.phase || 'Analysis workflow') === phase)
          const delegations = [
            ...new Set(
              phaseSteps.map((step) => step.delegation || planData.delegation_name || 'Main Agent')
            )
          ]
          return h(
            'section',
            { class: 'dv-native-plan-phase dv-plan-phase' },
            h('div', { class: 'dv-native-plan-phase-label' }, 'PHASE ' + (phaseIndex + 1)),
            h('h2', {}, phase),
            ...delegations.map((delegation) =>
              h(
                'div',
                { class: 'dv-native-plan-delegation' },
                h('span', { class: 'dv-native-plan-rail-node', 'aria-hidden': 'true' }),
                h(
                  'div',
                  { class: 'dv-native-plan-agent' },
                  h('span', {}, delegation),
                  h('small', {}, delegations.length === 1 ? 'primary agent' : 'runs in parallel')
                ),
                ...phaseSteps
                  .filter(
                    (step) =>
                      (step.delegation || planData.delegation_name || 'Main Agent') === delegation
                  )
                  .map((step) => {
                    const done = Number.isFinite(step.completed_at) && now >= step.completed_at
                    return h(
                      'div',
                      { class: 'dv-native-plan-document-step' },
                      h(
                        'span',
                        {
                          class: 'dv-native-plan-mark' + (done ? ' done' : ''),
                          'aria-label':
                            step.title + ' status: ' + (done ? 'completed' : 'not started')
                        },
                        done ? '✓' : ''
                      ),
                      h(
                        'div',
                        {},
                        h('div', { class: 'dv-native-plan-document-step-title' }, step.title),
                        h(
                          'div',
                          { class: 'dv-native-plan-document-step-description' },
                          step.detail || step.description || ''
                        )
                      )
                    )
                  })
              )
            )
          )
        }),
        h(
          'section',
          { class: 'dv-native-plan-outputs' },
          h('h2', {}, 'Desired outputs'),
          h('ul', {}, ...(planData.desired_outputs || []).map((output) => h('li', {}, output)))
        ),
        h(
          'div',
          { class: 'dv-native-plan-scope' },
          h(
            'div',
            {},
            nativeIcon('info'),
            'SCOPE & FEASIBILITY',
            ' · ',
            planData.feasibility?.confidence ? planData.feasibility.confidence + ' confidence' : ''
          ),
          h('p', {}, planData.feasibility?.rationale || '')
        ),
        h('p', { class: 'dv-native-plan-summary-copy', 'aria-hidden': 'true' }, summary)
      )
    ]
  }
  function panelSceneFor(s) {
    if (s.kind !== 'export') return s
    return (
      scenes
        .slice(0, scenes.indexOf(s))
        .reverse()
        .find((previous) => {
          if (previous.kind === 'run') return true
          if (previous.kind === 'result')
            return Boolean(selectedArtifact(previous, durationOf(previous)))
          return (
            previous.kind === 'plan' &&
            usablePlan(planForScene(previous)) &&
            actionAt(previous, 'open_plan') < durationOf(previous)
          )
        }) || null
    )
  }
  function panelProjection(s, local) {
    if (s.kind === 'export') {
      s = panelSceneFor(s)
      if (s) local = durationOf(s)
    }
    if (
      !s ||
      ['opening', 'paper', 'upload', 'prompt', 'controls', 'conversation', 'outro'].includes(s.kind)
    )
      return { mode: 'hidden', scene: s, local }
    if (s.kind === 'plan')
      return {
        mode: usablePlan(planForScene(s)) && happened(s, 'open_plan', local) ? 'plan' : 'hidden',
        scene: s,
        local
      }
    const selected = selectedArtifact(s, local),
      result = selected || resultBy(s.result_id || sceneResults(s)[0]?.id),
      done = local >= completionOf(s)
    if (s.kind === 'run')
      return { mode: selected ? 'artifact' : 'notebook', scene: s, local, result, done }
    return { mode: selected ? 'artifact' : 'pending', scene: s, local, result, done }
  }
  function panelSync(s, local) {
    const projection = panelProjection(s, local)
    panel.style.display = projection.mode === 'hidden' ? 'none' : 'flex'
    if (projection.mode === 'hidden') return
    s = projection.scene
    local = projection.local
    const planData = planForScene(s),
      r = projection.result,
      plan = projection.mode === 'plan'
    const planProgress = (planData.steps || [])
      .map((step) => (Number.isFinite(step.completed_at) && now >= step.completed_at ? '1' : '0'))
      .join('')
    const key =
      s.id +
      '|' +
      projection.mode +
      '|' +
      projection.done +
      '|' +
      r?.id +
      '|' +
      planData.id +
      '|' +
      planProgress +
      '|' +
      happened(s, 'approve_plan', local) +
      '|' +
      (planLifecycleAt(planData)?.phase || '')
    if (key === lastPanelKey) return
    lastPanelKey = key
    const artifact = projection.mode === 'artifact',
      label = plan
        ? 'Session Plan'
        : projection.mode === 'notebook'
          ? 'Notebook'
          : r?.name || 'Results'
    tabs.classList.toggle('adn-tab-strip', artifact)
    if (artifact) {
      tabs.setAttribute('role', 'tablist')
      tabs.setAttribute('aria-label', 'Open previews')
      tabs.replaceChildren(...artifactTabs(r))
    } else {
      tabs.removeAttribute('role')
      tabs.removeAttribute('aria-label')
      tabs.replaceChildren(
        h(
          'span',
          { class: 'dv-panel-tab' },
          icon(plan ? 'file' : projection.mode === 'notebook' ? 'book' : 'file'),
          label,
          ' ×'
        ),
        h('span', { style: { marginLeft: 'auto' } }, icon('panelRight'))
      )
    }
    content.replaceChildren(
      ...(plan
        ? planView(s, local)
        : projection.mode === 'notebook'
          ? notebook(r, s, local)
          : artifact
            ? resultView(r)
            : [
                h(
                  'div',
                  { class: 'dv-report', 'data-status': 'pending' },
                  projection.done ? 'Select a delivered file to inspect it.' : 'Awaiting result'
                )
              ]
      ).filter(Boolean)
    )
  }
  function planApproval(s, p) {
    const planData = planForScene(s),
      hasPlan = usablePlan(planData),
      approval = approvalMode(planData)
    composer.planHost.replaceChildren()
    const local = p * durationOf(s),
      approved = happened(s, 'approve_plan', local)
    const lifecycle = planLifecycleAt(planData)
    if (lifecycle?.phase === 'approved')
      targets.openPlan = targets.planProgress?.querySelector('button')
    if (
      lifecycle
        ? !['awaiting_approval', 'approving'].includes(lifecycle.phase)
        : s.kind !== 'plan' || !hasPlan || !happened(s, 'plan_ready', local)
    )
      return
    if (planData.native_components === true) {
      if ((!lifecycle && approved) || approval === 'omit') return
      const busy = lifecycle?.phase === 'approving'
      const open = h('button', { class: 'dv-native-plan-outline', type: 'button' }, 'Open')
      const approve = h(
        'button',
        { class: 'dv-native-plan-primary', type: 'button', disabled: busy },
        'Approve'
      )
      targets.openPlan = open
      targets.approvePlan = approve
      composer.planHost.append(
        h(
          'article',
          { class: 'dv-native-plan-approval', 'aria-busy': String(busy) },
          h(
            'div',
            { class: 'dv-native-plan-approval-top' },
            h(
              'div',
              { class: 'dv-native-plan-approval-heading' },
              h(
                'div',
                { class: 'dv-native-plan-lifecycle' },
                nativeIcon('list-checks'),
                'Plan ready for review'
              ),
              h(
                'div',
                { class: 'dv-native-plan-approval-summary' },
                planData.approval_summary ||
                  planData.task_summary ||
                  planData.title ||
                  'Analysis plan'
              )
            ),
            h('div', { class: 'dv-approval-actions' }, open, approve)
          ),
          planData.feasibility?.confidence
            ? h(
                'div',
                { class: 'dv-native-plan-approval-confidence' },
                h('span'),
                planData.feasibility.confidence + ' confidence'
              )
            : null,
          h(
            'form',
            { class: 'dv-native-plan-response' },
            h(
              'div',
              { class: 'dv-native-plan-response-box' },
              h(
                'div',
                { class: 'dv-native-plan-response-input' },
                nativeIcon('pencil'),
                h('textarea', {
                  rows: 1,
                  placeholder: 'Describe changes to the Plan…',
                  'aria-label': 'Respond to Plan',
                  disabled: busy
                })
              ),
              h(
                'div',
                { class: 'dv-native-plan-response-footer' },
                h(
                  'div',
                  { class: 'dv-native-plan-shortcuts' },
                  h('span', {}, h('kbd', {}, 'Return'), ' Send'),
                  h('span', {}, h('kbd', {}, 'Shift'), ' + ', h('kbd', {}, 'Return'), ' New line')
                ),
                h(
                  'button',
                  {
                    class: 'dv-native-plan-outline',
                    type: 'button',
                    'aria-label': 'Send Plan feedback',
                    disabled: true
                  },
                  nativeIcon('corner-down-left')
                )
              )
            )
          )
        )
      )
      return
    }
    const open = h('button', { class: 'dv-button' }, 'Open plan'),
      approve = h(
        'button',
        { class: 'dv-button primary' },
        approved
          ? approval === 'demonstration'
            ? 'Approved · demonstration'
            : 'Approved'
          : 'Approve'
      )
    targets.openPlan = open
    targets.approvePlan = approve
    composer.planHost.append(
      h(
        'div',
        { class: 'dv-approval' },
        h(
          'div',
          { class: 'dv-approval-top' },
          icon('files'),
          h('b', {}, planData.title || 'Analysis plan')
        ),
        h(
          'small',
          {},
          approval === 'omit'
            ? 'Recorded plan available for review.'
            : approval === 'archival'
              ? 'Recorded plan review and approval.'
              : 'Demonstration of plan review and approval · not an archival approval record.'
        ),
        h('div', { class: 'dv-approval-actions' }, open, approval === 'omit' ? null : approve)
      )
    )
  }
  function composeState(s, local) {
    const previous = interactionTracks.filter((track) => track.start < Number(s.start || 0)),
      prompt = promptForScene(s),
      plan = planForScene(s)
    const prior = (kind) => previous.some((track) => track.actions.some((e) => e.kind === kind))
    const common = {
      scene: 'idle',
      progress: 0,
      permission: 'full',
      skipAccessSetup: true,
      autoReview:
        Boolean(C.auto_review) ||
        prior('toggle_auto_review') ||
        happened(s, 'toggle_auto_review', local),
      computeEnabled:
        Boolean(C.environment?.initial_enabled) ||
        prior('toggle_compute') ||
        happened(s, 'toggle_compute', local),
      uploadStates: (C.attachments || []).map(() => 'absent'),
      typedPrompt: ''
    }
    const lifecycle = planLifecycleAt(plan)
    const activity = agentActivityAt(plan, now)
    if (C.show_agent_thinking === true) common.runActive = Boolean(activity?.running)
    if (lifecycle) {
      common.planStatus = lifecycle.phase
      if (lifecycle.phase === 'approved') {
        const completed = (plan.steps || []).filter(
          (step) => Number.isFinite(step.completed_at) && now >= step.completed_at
        ).length
        if (completed < plan.steps.length)
          common.planProgress = { completed, total: plan.steps.length }
      }
      if (['awaiting_approval', 'approving'].includes(lifecycle.phase))
        return { ...common, scene: 'plan', progress: 1 }
      const running =
        C.show_agent_thinking === true
          ? Boolean(activity?.running)
          : ['preparing', 'thinking', 'generating'].includes(lifecycle.phase) ||
            (lifecycle.phase === 'approved' && now < lifecycle.continuedUntil)
      if (running) return { ...common, scene: 'running', runActive: true }
      if (s.kind === 'plan') return common
    }
    if (!lifecycle && s.kind === 'plan' && usablePlan(plan) && approvalMode(plan) !== 'omit')
      return {
        ...common,
        scene: 'plan',
        progress:
          plan.native_components === true && happened(s, 'plan_ready', local)
            ? 1
            : part(local, 0, durationOf(s)),
        planStatus: happened(s, 'approve_plan', local) ? 'approved' : 'awaiting_approval'
      }
    if (!['upload', 'prompt', 'controls'].includes(s.kind)) return common
    const submitted = submissionFor(s) && local >= submissionFor(s).at
    const controlsOpen =
      happened(s, 'open_controls', local) && !happened(s, 'close_controls', local) && !submitted
    const computeMenuOpen = controlsOpen && happened(s, 'open_compute', local)
    const sendMenuOpen = happened(s, 'open_send_menu', local) && !submitted
    const addMenuOpen = happened(s, 'open_attach', local) && !happened(s, 'open_picker', local)
    const typeStart = actionAt(s, 'typing_start', 0),
      typeEnd = actionAt(s, 'typing_end', 0),
      typing = part(local, typeStart, typeEnd)
    const typed = prompt
      ? text(prompt.text).slice(0, Math.floor(text(prompt.text).length * typing))
      : ''
    const confirmed = happened(s, 'confirm_picker', local),
      ready = happened(s, 'upload_ready', local),
      wasUploaded = prior('upload_ready')
    let progress = submitted
      ? 0.99
      : addMenuOpen
        ? 0.04
        : controlsOpen
          ? 0.6
          : sendMenuOpen
            ? 0.9
            : 0.1 + 0.4 * typing
    if (s.kind === 'upload' && !confirmed && !wasUploaded && !addMenuOpen) progress = 0.02
    return {
      ...common,
      scene: 'compose',
      progress,
      typedPrompt: submitted ? '' : typed,
      controlsOpen,
      computeMenuOpen,
      planFirstHover: sendMenuOpen && local >= actionAt(s, 'plan_first') - 0.25,
      ui_operation: computeMenuOpen
        ? 'compute'
        : sendMenuOpen
          ? 'plan-first'
          : controlsOpen
            ? 'controls'
            : submitted
              ? 'submitted'
              : 'typing',
      uploadStates: (C.attachments || []).map((file) =>
        file.prompt_id === s.prompt_id && confirmed && !submitted
          ? ready
            ? 'uploaded'
            : 'uploading'
          : 'absent'
      ),
      uploadProgresses: (C.attachments || []).map(() =>
        part(local, actionAt(s, 'confirm_picker'), actionAt(s, 'upload_ready'))
      )
    }
  }
  const V = {
    wide: { z: 1, x: 0, y: 0 },
    input: { z: 1.45, x: -610, y: -480 },
    controls: { z: 1.65, x: -670, y: -620 },
    plan: { z: 1.38, x: -703, y: -80 },
    conversation: { z: 1.35, x: 0, y: 0 },
    approve: { z: 1.6, x: -920, y: -120 },
    result: { z: 1.22, x: -420, y: -80 }
  }
  let compiledCamera = null
  function cameraTransition(scene) {
    const length = durationOf(scene)
    const fallback =
      scene.kind === 'export' ? Math.min(0.65, length * 0.14) : Math.min(0.75, length * 0.35)
    return clamp(scene.camera_transition ?? fallback, 0, length)
  }
  function conversationTarget(scene) {
    const focus = scene?.conversation_focus
    if (!focus) return null
    const entry = [...ws.thread.children].find(
      (node) => node.dataset.historyId === focus.message_id
    )
    return entry?.querySelector(focus.selector || 'table') || null
  }
  function cameraView(name, scene) {
    const base = V[name] || V.wide
    let anchors = []
    if (name === 'input')
      anchors = [composer.input, composer.composer.querySelector('.oc2-toolbar')]
    else if (name === 'controls') anchors = [composer.controlsMenu]
    else if (name === 'approve') anchors = [composer.planHost.querySelector('.dv-approval-actions')]
    else if (name === 'plan')
      anchors = [
        content.querySelector('.dv-native-plan-header'),
        content.querySelector('.dv-plan-title'),
        content.querySelector('.dv-plan-phase')
      ]
    else if (name === 'conversation') {
      const table = conversationTarget(scene)
      if (table)
        anchors = [...table.querySelectorAll('tr')].slice(
          0,
          1 + (scene.conversation_focus.rows || 2)
        )
    } else if (name === 'result') {
      const result = content.querySelector(
        '.dv-image-body img,.dv-table,.dv-report .dv-rich-text,.dv-package'
      )
      anchors = result
        ? [result]
        : [content.querySelector('.dv-code'), content.querySelector('.dv-output')]
    }
    const boxes = anchors
      .filter(
        (anchor) =>
          anchor?.isConnected &&
          anchor.getClientRects().length &&
          !anchor.hidden &&
          getComputedStyle(anchor).display !== 'none'
      )
      .map((anchor) => anchor.getBoundingClientRect())
    if (
      !boxes.length &&
      ['plan', 'result'].includes(name) &&
      panel.getClientRects().length &&
      getComputedStyle(panel).display !== 'none'
    )
      boxes.push(panel.getBoundingClientRect())
    if (!boxes.length) return name === 'result' ? V.wide : base
    const left = Math.min(...boxes.map((box) => box.left)),
      top = Math.min(...boxes.map((box) => box.top)),
      right = Math.max(...boxes.map((box) => box.right)),
      bottom = Math.max(...boxes.map((box) => box.bottom))
    const a = { left, top, width: right - left, height: bottom - top },
      b = bg.getBoundingClientRect(),
      scale = b.width / W
    if (!scale) return base
    const cx = (a.left + a.width * 0.5 - b.left) / scale,
      cy = (a.top + a.height * 0.5 - b.top) / scale
    const width = a.width / scale,
      height = a.height / scale,
      margin = 32
    const z = Math.max(1, Math.min(base.z, (W - 2 * margin) / width, (H - 2 * margin) / height))
    return { z, x: clamp(W / 2 - cx * z, W * (1 - z), 0), y: clamp(H / 2 - cy * z, H * (1 - z), 0) }
  }
  function sceneCameraShots(scene) {
    const length = durationOf(scene)
    const entrance = cameraTransition(scene)
    let intent = 'workspace'
    let shots
    if (Array.isArray(scene.camera_shots) && scene.camera_shots.length) {
      intent = 'explicit_shots'
      shots = scene.camera_shots.map((shot) => ({ ...shot }))
    } else if (scene.camera && scene.camera !== 'auto') {
      intent = 'requested_view'
      shots = [
        { at: 0, view: scene.camera },
        { at: length, view: scene.camera }
      ]
    } else if (scene.kind === 'controls') {
      intent = 'operation'
      const menuAction = actionAt(
        scene,
        scene.control === 'compute' ? 'toggle_compute' : 'toggle_auto_review',
        length * 0.42
      )
      const menuAt = Math.min(entrance, menuAction * 0.65),
        close = actionAt(scene, 'close_controls', length * 0.72)
      const nextInput = Math.min(
        actionAt(scene, 'typing_start'),
        actionAt(scene, 'open_send_menu'),
        actionAt(scene, 'submit'),
        actionAt(scene, 'plan_first'),
        close + 0.35
      )
      const holdAt = Math.max(menuAt, Math.min(menuAction + 0.12, close - 0.05))
      const inputAt = Math.min(length, Math.max(holdAt + 0.1, nextInput - 0.05))
      shots = [
        { at: menuAt, view: 'controls' },
        { at: holdAt, view: 'controls' },
        { at: inputAt, view: 'input' },
        { at: length, view: 'input' }
      ]
    } else if (['upload', 'prompt'].includes(scene.kind)) {
      intent = 'operation'
      const view = 'input'
      shots = [
        { at: entrance, view },
        { at: length, view }
      ]
    } else if (scene.kind === 'plan') {
      intent = 'plan_review'
      const open = actionAt(scene, 'open_plan'),
        ready = actionAt(scene, 'plan_ready'),
        approve = actionAt(scene, 'approve_plan')
      const approach = Math.max(ready + 0.02, Math.min(entrance, open - 0.12)),
        openHold = Math.min(length, open + 0.14)
      shots = [
        { at: approach, view: 'approve' },
        { at: openHold, view: 'approve' }
      ]
      if (Number.isFinite(approve)) {
        const available = Math.max(0.001, approve - openHold),
          contentAt = openHold + Math.min(0.45, available * 0.35)
        const readHold = Math.max(contentAt, approve - Math.min(0.6, available * 0.4)),
          approveAt = approve - Math.min(0.1, available * 0.08)
        shots.push(
          { at: contentAt, view: 'plan' },
          { at: readHold, view: 'plan' },
          { at: approveAt, view: 'approve' },
          { at: length, view: 'approve' }
        )
      } else
        shots.push(
          {
            at: Math.min(length, openHold + Math.min(0.45, (length - openHold) * 0.35)),
            view: 'plan'
          },
          { at: length, view: 'plan' }
        )
    } else if (
      scene.kind === 'result' &&
      (scene.result_ids || [scene.result_id]).some((id) => resultBy(id))
    ) {
      intent = 'result_review'
      shots = [
        { at: Math.min(length, actionAt(scene, 'open_artifact') + entrance), view: 'result' },
        { at: length, view: 'result' }
      ]
    } else {
      shots = [
        { at: entrance, view: 'wide' },
        { at: length, view: 'wide' }
      ]
    }
    shots = shots
      .map((shot) => ({ ...shot, at: clamp(shot.at, 0, length), intent }))
      .sort((a, b) => a.at - b.at)
    if (scene.camera_return === 'wide' && shots.at(-1).view !== 'wide') {
      const last = shots.pop()
      const holdAt = Math.max(shots.at(-1)?.at || 0, length - Math.min(0.5, length * 0.18))
      shots.push({ ...last, at: holdAt }, { at: length, view: 'wide', intent: 'return_wide' })
    }
    return { shots, intent }
  }
  function compileCameraPlan() {
    const savedTime = now
    const savedTransform = bg.style.transform
    const tracks = []
    let previousPose = { ...V.wide, name: 'wide' }
    bg.style.transform = 'none'
    for (const [index, scene] of scenes.entries()) {
      const length = durationOf(scene)
      const fixed = C.camera_mode === 'fixed'
      const specification = fixed
        ? {
            shots: [
              { at: 0, view: 'wide' },
              { at: length, view: 'wide' }
            ],
            intent: 'fixed'
          }
        : sceneCameraShots(scene)
      const shots = specification.shots
      const cut = scene.camera_cut === true && !fixed
      const keyframes = []
      if (!cut && (index > 0 || shots[0].at > 0)) {
        keyframes.push({ at: 0, view: 'inherit', pose: { ...previousPose }, intent: 'inherit' })
      }
      for (const [shotIndex, shot] of shots.entries()) {
        let at = shot.at
        if (at === 0 && keyframes.length) {
          const nextAt = shots[shotIndex + 1]?.at || length
          at = Math.min(cameraTransition(scene), nextAt * 0.5)
        }
        const preceding = keyframes.at(-1)
        let pose
        if (preceding?.view === shot.view) {
          pose = { ...preceding.pose }
        } else {
          const sampleAt = Math.min(at, Math.max(0, length - 1e-7))
          now = Number(scene.start || 0) + sampleAt
          syncWorkspace(scene, sampleAt)
          pose = { ...cameraView(shot.view, scene), name: shot.view }
        }
        keyframes.push({ at, view: shot.view, pose, intent: shot.intent || specification.intent })
      }
      if (keyframes.at(-1).at < length) keyframes.push({ ...keyframes.at(-1), at: length })
      tracks.push({
        scene_id: scene.id,
        start: Number(scene.start || 0),
        duration: length,
        camera_group: scene.camera_group || null,
        camera_cut: cut,
        camera_return: scene.camera_return || null,
        intent: specification.intent,
        keyframes
      })
      previousPose = { ...keyframes.at(-1).pose }
    }
    now = savedTime
    const current = sceneAt(now)
    syncWorkspace(current, now - Number(current.start || 0))
    bg.style.transform = savedTransform
    return tracks
  }
  function cameraPlan() {
    if (!compiledCamera) compiledCamera = compileCameraPlan()
    return compiledCamera
  }
  function lens(scene, local) {
    const track = cameraPlan().find((item) => item.scene_id === scene.id)
    if (!track) return { ...V.wide, name: 'wide' }
    const frames = track.keyframes
    let from = frames[0],
      to = frames.at(-1)
    for (let index = 0; index < frames.length - 1; index++) {
      if (local >= frames[index].at && local < frames[index + 1].at) {
        from = frames[index]
        to = frames[index + 1]
        break
      }
    }
    if (local >= frames.at(-1).at) from = to = frames.at(-1)
    const progress = from === to ? 0 : ease(part(local, from.at, to.at))
    return {
      z: lerp(from.pose.z, to.pose.z, progress),
      x: lerp(from.pose.x, to.pose.x, progress),
      y: lerp(from.pose.y, to.pose.y, progress),
      name: from.pose.name === to.pose.name ? from.pose.name : from.pose.name + ' → ' + to.pose.name
    }
  }
  function pointerAnchor(target, s) {
    if (target?.startsWith('picker.file:'))
      return systems.querySelector('[data-file-index="' + Number(target.split(':')[1]) + '"]')
    if (target?.startsWith('artifact:'))
      return [...ws.thread.querySelectorAll('[data-result-id]')].findLast(
        (node) => node.dataset.resultId === target.slice('artifact:'.length)
      )
    if (target?.startsWith('reviewer:'))
      return [...ws.thread.querySelectorAll('[data-target]')].find(
        (node) => node.dataset.target === target
      )
    if (target?.startsWith('plan.'))
      return [...stage.querySelectorAll('[data-target]')].find(
        (node) => node.dataset.target === target
      )
    const selectors = {
      'picker.open': '[data-target="picker.open"]',
      'export.menu': '[data-target="export.menu"]',
      'export.package': '[data-target="export.package"]',
      'export.location': '[data-target="export.location"]',
      'export.save': '[data-target="export.save"]'
    }
    if (selectors[target]) return systems.querySelector(selectors[target])
    if (target === 'artifact')
      return [...ws.thread.querySelectorAll('[data-result-id]')].findLast(
        (node) => node.dataset.resultId === (s.result_id || sceneResults(s)[0]?.id)
      )
    if (target === 'remote.job')
      return [...ws.thread.querySelectorAll('.dv-remote-card')].find(
        (node) => node.dataset.jobId === s.job_id
      )
    if (target === 'remote.outputs') return systems.querySelector('.dv-outputs-bar')
    if (target === 'remote.close') return systems.querySelector('[data-target="remote.close"]')
    if (target === 'download') return content.querySelector('.dv-download,.dv-file-download')
    return targets[target]
  }
  function pointerTarget(s, at, target, plane) {
    now = Number(s.start || 0) + at
    syncWorkspace(s, at)
    systemSync(s, at)
    const anchor = pointerAnchor(target, s)
    if (
      !anchor?.isConnected ||
      !anchor.getClientRects().length ||
      getComputedStyle(anchor).display === 'none'
    )
      return null
    const a = anchor.getBoundingClientRect(),
      b = stage.getBoundingClientRect(),
      scale = b.width / W
    const rect = {
      x: (a.left - b.left) / scale,
      y: (a.top - b.top) / scale,
      width: a.width / scale,
      height: a.height / scale
    }
    return { target, plane, x: rect.x + rect.width * 0.55, y: rect.y + rect.height * 0.55, rect }
  }
  let compiledPointers = null
  function pointerPlan() {
    if (compiledPointers) return compiledPointers
    const savedTime = now,
      savedTransform = bg.style.transform,
      tracks = []
    bg.style.transform = 'none'
    for (const s of scenes) {
      const actions = actionsFor(s),
        frames = [],
        clicks = [],
        missing = []
      for (const action of actions.filter((e) => e.actor === 'user' && e.target)) {
        const point = pointerTarget(s, Math.max(0, action.at - 0.0001), action.target, action.plane)
        if (!point) {
          missing.push({ id: action.id, at: action.at, target: action.target })
          continue
        }
        clicks.push({
          ...point,
          at: action.at,
          id: action.id,
          click: action.click,
          kind: action.kind
        })
      }
      if (Array.isArray(s.pointer_track) && s.pointer_track.length) {
        for (const authored of s.pointer_track) {
          const point =
            pointerTarget(s, Number(authored.at), authored.target, authored.plane || 'workspace') ||
            pointerTarget(
              s,
              Math.max(0, Number(authored.at) - 0.0001),
              authored.target,
              authored.plane || 'workspace'
            )
          if (point) frames.push({ ...point, at: Number(authored.at) })
          else missing.push({ at: authored.at, target: authored.target })
        }
      } else {
        for (const point of clicks) {
          const previous = frames.at(-1),
            arrive = point.at,
            departure = Math.max(previous?.at ?? 0, arrive - 0.4)
          if (previous) frames.push({ ...previous, at: departure })
          else frames.push({ ...point, x: point.x - 50, y: point.y + 32, at: departure })
          frames.push({ ...point, at: arrive })
          const next = clicks[clicks.indexOf(point) + 1]
          const hold = next ? Math.min(0.16, Math.max(0, next.at - arrive) * 0.35) : 0.16
          frames.push({ ...point, at: Math.min(arrive + hold, durationOf(s)) })
        }
      }
      frames.sort((a, b) => a.at - b.at)
      tracks.push({
        scene_id: s.id,
        start: Number(s.start || 0),
        duration: durationOf(s),
        frames,
        clicks,
        missing_targets: missing
      })
    }
    now = savedTime
    const current = sceneAt(now)
    syncWorkspace(current, now - Number(current.start || 0))
    systemSync(current, now - Number(current.start || 0))
    bg.style.transform = savedTransform
    compiledPointers = tracks
    return tracks
  }
  function projectPointer(point, camera) {
    const project = (x, y) =>
      point.plane === 'system'
        ? { x, y }
        : { x: camera.x + x * camera.z, y: camera.y + y * camera.z }
    const xy = project(point.x, point.y),
      corner = project(point.rect.x, point.rect.y),
      z = point.plane === 'system' ? 1 : camera.z
    return {
      ...xy,
      rect: { ...corner, width: point.rect.width * z, height: point.rect.height * z }
    }
  }
  function positionPointer(s, local) {
    const track = pointerPlan().find((item) => item.scene_id === s.id),
      frames = track?.frames || []
    if (!frames.length || local < frames[0].at || local > frames.at(-1).at + 0.22) {
      visible(pointer, false)
      visible(click, false)
      state.pointer = { visible: false, plane: null, target: null, pressed: false }
      return
    }
    let from = frames[0],
      to = frames.at(-1)
    for (let i = 0; i < frames.length - 1; i++)
      if (local >= frames[i].at && local < frames[i + 1].at) {
        from = frames[i]
        to = frames[i + 1]
        break
      }
    if (local >= frames.at(-1).at) from = to = frames.at(-1)
    const a = projectPointer(from, state.camera),
      b = projectPointer(to, state.camera),
      q = from === to ? 0 : ease(part(local, from.at, to.at))
    const x = lerp(a.x, b.x, q),
      y = lerp(a.y, b.y, q),
      press = track.clicks.findLast((e) => e.click && local >= e.at && local < e.at + 0.14),
      clicked = press ? projectPointer(press, state.camera) : null
    visible(pointer, true)
    pointer.style.left = x + 'px'
    pointer.style.top = y + 'px'
    visible(click, !!press)
    if (press) {
      click.style.left = clicked.x + 'px'
      click.style.top = clicked.y + 'px'
    }
    state.pointer = {
      visible: true,
      plane: press?.plane || to.plane,
      x,
      y,
      target: press?.target || to.target,
      pressed: !!press,
      action_id: press?.id || null,
      target_rect: clicked?.rect || b.rect
    }
  }
  function showcaseResults(s, local) {
    const cue = s.showcase_at ?? (s.kind === 'opening' ? 0 : Infinity)
    if (!Number.isFinite(Number(cue)) || local < Number(cue)) return []
    return (s.result_ids || [])
      .map(resultBy)
      .filter((r) => r?.type === 'image' && r.src)
      .slice(0, 6)
  }
  function openingOverlay(s) {
    const results = (s.result_ids || [])
      .map(resultBy)
      .filter((result) => result?.type === 'image' && result.src)
      .slice(0, 6)
    const title =
      s.showcase_title || (s.kind === 'opening' ? C.project_title || C.title : C.title) || ''
    return window.OperationOpening.create({
      K,
      paper: C.paper || {},
      title,
      results,
      showArticle: s.kind === 'paper'
    })
  }
  function outroOverlay() {
    return window.OperationEndCard.create({ profile: C.profile })
  }
  function editorialSync(s, local) {
    const opening = ['opening', 'paper'].includes(s.kind),
      on = opening || s.kind === 'outro'
    visible(editorial, on)
    visible(brand, !on && s.hide_brand !== true)
    const showcase = opening ? showcaseResults(s, local) : [],
      key = on ? s.id + '|' + s.kind : ''
    if (key !== lastEditorialKey) {
      lastEditorialKey = key
      editorial.replaceChildren(
        ...(opening ? [openingOverlay(s)] : s.kind === 'outro' ? [outroOverlay()] : [])
      )
    }
    if (opening) {
      window.OperationOpening.update(editorial.firstElementChild, {
        local,
        showcaseAt: s.showcase_at,
        duration: durationOf(s)
      })
      if (s.kind === 'paper') state.paper_view = showcase.length ? 'showcase' : 'article'
      else state.opening_view = showcase.length ? 'showcase' : 'brand'
      state.showcase_result_ids = showcase.map((r) => r.id)
    }
    if (s.kind === 'outro')
      window.OperationEndCard.update(editorial.firstElementChild, {
        local,
        duration: durationOf(s)
      })
    bg.style.filter = on ? 'blur(3.5px) saturate(.88)' : 'none'
    editorial.style.background = opening ? '#ffffff55' : ''
  }
  function macOpen(s, local) {
    const files = C.attachments || [],
      selected = new Set(
        actionsFor(s)
          .filter((e) => e.kind === 'select_file' && e.at <= local)
          .map((e) => e.file_index ?? Number(e.target?.split(':')[1]))
      )
    const traffic = h('span', { class: 'dv-mac-lights' }, h('i'), h('i'), h('i'))
    return h(
      'div',
      { class: 'dv-dialog dv-mac-open', 'data-system-style': 'macOS' },
      h(
        'div',
        { class: 'dv-mac-head' },
        traffic,
        h('span', {}, '‹　›'),
        h('div', { class: 'dv-mac-folder' }, icon('files'), C.upload_folder || 'Downloads', '⌄'),
        h('div', { class: 'dv-mac-search' }, '⌕ Search')
      ),
      h(
        'div',
        { class: 'dv-mac-main' },
        h(
          'aside',
          { class: 'dv-mac-nav' },
          h('small', {}, 'Favorites'),
          h('div', {}, 'Recents'),
          h('div', {}, 'Desktop'),
          h('div', {}, 'Documents'),
          h('div', { class: 'active' }, 'Downloads')
        ),
        h(
          'div',
          { class: 'dv-mac-files' },
          h(
            'div',
            { class: 'dv-mac-columns' },
            h('span', {}, 'Name'),
            h('span', {}, 'Kind'),
            h('span', {}, 'Size')
          ),
          ...files.flatMap((f, i) =>
            f.prompt_id !== s.prompt_id
              ? []
              : [
                  h(
                    'div',
                    {
                      class: 'dv-mac-file' + (selected.has(i) ? ' selected' : ''),
                      'data-file-index': i,
                      'data-selected': String(selected.has(i))
                    },
                    h('span', {}, icon('file'), f.name),
                    h(
                      'span',
                      {},
                      /\.pdf$/i.test(f.name)
                        ? 'PDF document'
                        : /\.xlsx?$/i.test(f.name)
                          ? 'Spreadsheet'
                          : /\.(zip|tar|gz)$/i.test(f.name)
                            ? 'Archive'
                            : 'Document'
                    ),
                    h('span', {}, f.label || formatBytes(f.bytes))
                  )
                ]
          )
        )
      ),
      h(
        'footer',
        { class: 'dv-mac-footer' },
        h('span', { class: 'dv-mac-note' }, selected.size + ' selected'),
        h('span', { class: 'dv-mac-button' }, 'Cancel'),
        h('span', { class: 'dv-mac-button primary', 'data-target': 'picker.open' }, 'Open')
      )
    )
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes))) return ''
    return bytes >= 1e9
      ? (bytes / 1e9).toFixed(2) + ' GB'
      : bytes >= 1e6
        ? (bytes / 1e6).toFixed(2) + ' MB'
        : bytes >= 1e3
          ? (bytes / 1e3).toFixed(1) + ' KB'
          : bytes + ' B'
  }
  function macSave() {
    return h(
      'div',
      { class: 'dv-dialog dv-mac-save', 'data-system-style': 'macOS' },
      h(
        'div',
        { class: 'dv-save-grid' },
        h('label', {}, 'Save As:'),
        h('div', { class: 'dv-save-input focus' }, exportName),
        h('span', { class: 'dv-save-arrow' }, '⌄'),
        h('label', {}, 'Tags:'),
        h('div', { class: 'dv-save-input' }),
        h('span'),
        h('label', {}, 'Where:'),
        h('div', { class: 'dv-save-input' }, '▱　Downloads'),
        h('span')
      ),
      h(
        'div',
        { class: 'dv-save-actions' },
        h('small', {}, 'Open-Science Session (.science)'),
        h('span', { class: 'dv-mac-button' }, 'Cancel'),
        h('span', { class: 'dv-mac-button primary', 'data-target': 'export.save' }, 'Save')
      )
    )
  }
  function exportPackage(status) {
    if ([fallbackPlan, ...plans].some((plan) => plan.native_components === true))
      return nativeExportPackage(status)
    const done = status === 'complete',
      writing = status === 'writing'
    return h(
      'div',
      { class: 'dv-dialog dv-export-package' },
      h(
        'header',
        { class: 'dv-package-title' },
        'Export Session package',
        h('span', { style: { float: 'right' } }, '×')
      ),
      h(
        'main',
        {},
        done || writing
          ? h(
              'div',
              { class: 'dv-export-success' },
              icon(done ? 'check' : 'files'),
              done ? 'Session package exported' : 'Writing session package…'
            )
          : h(
              'div',
              { class: 'dv-export-presets' },
              h(
                'div',
                { class: 'dv-export-preset active' },
                '◉ Full export',
                h('small', {}, 'Conversation, files and reproducibility records')
              ),
              h(
                'div',
                { class: 'dv-export-preset' },
                '○ Conversation only',
                h('small', {}, 'Messages and linked references')
              )
            ),
        h('small', { class: 'dv-mac-note' }, exportName)
      ),
      h(
        'footer',
        {},
        h('span', { class: 'dv-button' }, 'Cancel'),
        h(
          'span',
          { class: 'dv-button primary', 'data-target': 'export.location' },
          done ? 'Done' : writing ? 'Exporting…' : 'Choose save location'
        )
      )
    )
  }
  function nativeExportPackage(status) {
    const ready = status === 'ready'
    const complete = status === 'complete'
    const details = C.export_package || {}
    const preset = details.preset === 'full' ? 'full' : 'compact'
    return h(
      'div',
      { class: 'dv-dialog dv-native-export-package' },
      h(
        'header',
        {},
        h('h2', {}, 'Export Session package'),
        h(
          'button',
          { type: 'button', 'aria-label': complete ? 'Dismiss' : 'Hide progress' },
          icon('x')
        )
      ),
      h(
        'main',
        {},
        ready
          ? h(
              'div',
              { class: 'dv-native-export-selection' },
              h(
                'fieldset',
                {},
                ...['full', 'compact'].map((value) =>
                  h(
                    'label',
                    { class: value === preset ? 'selected' : '' },
                    h('input', { type: 'radio', name: 'export-preset', checked: value === preset }),
                    h(
                      'span',
                      {},
                      h(
                        'b',
                        {},
                        nativeIcon(value === 'full' ? 'files' : 'file-check-corner'),
                        value === 'full' ? 'Full export' : 'Essential export'
                      ),
                      h(
                        'small',
                        {},
                        value === 'full'
                          ? 'Plus all available files'
                          : 'History + required evidence'
                      )
                    )
                  )
                )
              ),
              Number.isFinite(details.estimated_bytes)
                ? h(
                    'div',
                    { class: 'dv-native-export-estimate' },
                    h(
                      'div',
                      {},
                      h('span', {}, 'Estimated size', nativeIcon('info')),
                      h('strong', {}, formatBytes(details.estimated_bytes))
                    ),
                    Number.isFinite(details.required_bytes)
                      ? h(
                          'p',
                          {},
                          h('span', {}, 'History and required evidence'),
                          h('span', {}, formatBytes(details.required_bytes))
                        )
                      : null,
                    Number.isFinite(details.optional_count)
                      ? h(
                          'p',
                          {},
                          'Optional files: ' +
                            Number(details.selected_optional_count || 0) +
                            ' / ' +
                            details.optional_count +
                            ' selected'
                        )
                      : null
                  )
                : null,
              h(
                'button',
                { type: 'button', class: 'dv-native-export-customize' },
                icon('chevronDown'),
                'Customize contents',
                nativeIcon('info')
              ),
              h(
                'div',
                { class: 'dv-native-export-transfer' },
                icon('chevronRight'),
                'Transfer settings'
              )
            )
          : h(
              'div',
              { class: 'dv-native-export-progress' },
              h(
                'div',
                { class: 'dv-native-export-progress-status' },
                nativeIcon(complete ? 'check' : 'loader-circle'),
                h(
                  'b',
                  {},
                  complete
                    ? 'Session package exported'
                    : status === 'writing'
                      ? 'Saving package…'
                      : 'Preparing package…'
                )
              ),
              !complete
                ? h(
                    'div',
                    {
                      class: 'dv-native-export-progress-track',
                      role: 'progressbar',
                      'aria-label': 'Package progress'
                    },
                    h('span')
                  )
                : h('p', {}, C.export_path || exportName),
              !complete
                ? h(
                    'div',
                    { class: 'dv-native-export-transfer' },
                    icon('chevronRight'),
                    'Transfer details'
                  )
                : null
            )
      ),
      h(
        'footer',
        {},
        !complete ? h('button', { type: 'button' }, 'Cancel') : null,
        h(
          'button',
          {
            class: complete ? 'dv-native-plan-outline' : 'dv-native-plan-primary',
            type: 'button',
            'data-target': ready ? 'export.location' : null
          },
          ready ? 'Choose save location…' : complete ? 'Close' : 'Run in background'
        )
      )
    )
  }
  function sessionActionsMenu(submenu) {
    const row = (name, label, target, active = false) =>
      h(
        'div',
        {
          class: 'dv-session-menu-item' + (active ? ' active' : ''),
          role: 'menuitem',
          'data-target': target
        },
        nativeIcon(name),
        h('span', {}, label)
      )
    const separator = () => h('div', { class: 'dv-session-separator', role: 'separator' })
    return h(
      'div',
      {
        class: 'dv-session-menu',
        role: 'menu',
        'aria-label': 'Session actions',
        'data-testid': 'session-header-menu'
      },
      row('pencil', 'Edit…'),
      row('pin', C.session_pinned ? 'Unpin' : 'Pin'),
      separator(),
      row('message-circle-more', 'New side chat'),
      row('git-branch', 'Fork'),
      row('video', 'Generate research film'),
      separator(),
      row('download', 'Export', 'export.menu', submenu),
      separator(),
      row('archive', 'Archive'),
      submenu
        ? h(
            'div',
            { class: 'dv-session-submenu', role: 'menu', 'aria-label': 'Export' },
            row('download', 'Export conversation…'),
            row('package', 'Export Session package', 'export.package'),
            row('stethoscope', 'Export diagnostics…')
          )
        : null
    )
  }
  function metaField(label, value, cls = '') {
    return h(
      'div',
      { class: 'dv-meta-field ' + cls },
      h('small', {}, label),
      h('span', {}, text(value))
    )
  }
  function remoteModal(job, s, local) {
    const status = jobStatus(s, local, job),
      failed = status === 'failed',
      done = status === 'finished' || failed,
      outputsOn = done && job.output_names.length > 0 && happened(s, 'open_remote_outputs', local),
      stderr = failed && !!job.stderr
    return h(
      'div',
      { class: 'dv-dialog dv-remote-modal', 'data-job-id': job.id },
      h(
        'header',
        { class: 'dv-remote-modal-head' },
        'Remote job details',
        h('span', { 'data-target': 'remote.close' }, '×')
      ),
      h(
        'div',
        { class: 'dv-jobbar' },
        h('small', {}, '‹ Back'),
        h('span', { class: 'dv-jobtitle' }, job.title),
        h('span', {}, 'Refresh'),
        h(
          'span',
          { class: 'dv-jobbadge' + (failed ? ' failed' : done ? '' : ' pending') },
          failed ? 'FAILED' : done ? 'DONE' : status.toUpperCase()
        )
      ),
      h(
        'div',
        { class: 'dv-meta' },
        h(
          'div',
          { class: 'dv-meta-row' },
          metaField('Provider', job.provider),
          metaField('Execution result', failed ? 'Failed' : done ? 'Success' : '—')
        ),
        h(
          'div',
          { class: 'dv-meta-row' },
          metaField(
            'Result collection',
            done ? (job.outputs_count ? 'Results collected' : 'No collected outputs') : 'Pending'
          ),
          metaField('Analysis', done && !failed ? 'Managed by result delivery' : '—')
        ),
        h(
          'div',
          { class: 'dv-meta-row' },
          metaField('Exit code', done ? (job.exit_code ?? '—') : '—'),
          metaField('Runtime', job.runtime ?? '—')
        ),
        h('div', { class: 'dv-meta-row single' }, metaField('Remote workdir', job.remote_workdir)),
        h('div', { class: 'dv-meta-row single' }, metaField('Job ID', job.id, 'dv-job-id'))
      ),
      h(
        'div',
        { class: 'dv-outputs-bar' },
        icon('files'),
        'Outputs' + (done ? ' (' + job.outputs_count + ')' : ''),
        '⌄',
        outputsOn
          ? h(
              'div',
              { class: 'dv-output-menu' },
              ...job.output_names
                .slice(0, 7)
                .map((name) => h('div', {}, icon('file'), h('span', {}, name)))
            )
          : null
      ),
      h('div', { class: 'dv-residency' }, '▸ Files left on remote'),
      h(
        'div',
        { class: 'dv-logtabs' },
        h('span', { class: stderr ? '' : 'active' }, 'stdout'),
        h('span', { class: stderr ? 'active' : '' }, 'stderr')
      ),
      h(
        'div',
        { class: 'dv-log-scroll' },
        h('pre', { class: 'dv-log' }, done ? (stderr ? job.stderr : job.stdout) : '…')
      )
    )
  }
  function systemSync(s, local) {
    const job = normalJob(jobBy(s.job_id))
    let key = '',
      node = null,
      kind = null
    if (
      s.kind === 'upload' &&
      happened(s, 'open_picker', local) &&
      !happened(s, 'confirm_picker', local)
    ) {
      key =
        'open|' +
        actionsFor(s)
          .filter((e) => e.kind === 'select_file' && e.at <= local)
          .map((e) => e.id)
          .join('|')
      node = macOpen(s, local)
      kind = 'open'
    } else if (s.kind === 'export') {
      if (happened(s, 'export_complete', local)) {
        key = 'exported'
        kind = 'exported'
        node = exportPackage('complete')
      } else if (happened(s, 'export_save', local)) {
        key = 'export-writing'
        kind = 'export-writing'
        node = exportPackage('writing')
      } else if (happened(s, 'choose_location', local)) {
        key = 'export-save'
        kind = 'save'
        node = macSave()
      } else if (happened(s, 'open_export', local)) {
        const preparedAt =
          s.package_prepared_at ??
          actionAt(s, 'open_export') +
            Math.min(
              0.6,
              Math.max(0, actionAt(s, 'choose_location') - actionAt(s, 'open_export')) * 0.5
            )
        const prepared = local >= preparedAt
        key = 'export-package|' + prepared
        kind = 'export-package'
        node = exportPackage(prepared ? 'ready' : 'preparing')
      } else if (happened(s, 'open_session_menu', local)) {
        const submenu = happened(s, 'open_export_menu', local)
        key = 'export-menu|' + submenu
        kind = 'session-menu'
        node = sessionActionsMenu(submenu)
      }
    } else if (
      s.kind === 'run' &&
      job &&
      s.details !== false &&
      happened(s, 'open_remote_details', local) &&
      !happened(s, 'close_remote_details', local)
    ) {
      key =
        'remote|' +
        job.id +
        '|' +
        jobStatus(s, local, job) +
        '|' +
        happened(s, 'open_remote_outputs', local)
      kind = 'remote-job'
      node = remoteModal(job, s, local)
    }
    if (key !== lastSystemKey) {
      lastSystemKey = key
      systems.replaceChildren(
        ...(node
          ? kind === 'session-menu'
            ? [node]
            : [h('div', { class: 'dv-shade' }), node]
          : [])
      )
    }
    const progress = systems.querySelector('.dv-native-export-progress-track')
    if (progress) {
      progress.firstElementChild.style.transform =
        'translateX(' + (Math.sin(now * 2.5) * 150 + 150) + '%)'
      systems.querySelector('.dv-native-export-progress-status>svg').style.transform =
        'rotate(' + now * 320 + 'deg)'
    }
    const sessionMenu = systems.querySelector('.dv-session-menu')
    if (sessionMenu) {
      const anchor = targets.sessionMore.getBoundingClientRect(),
        background = bg.getBoundingClientRect(),
        scale = background.width / W,
        camera = lens(s, local)
      const right = camera.x + ((anchor.right - background.left) / scale) * camera.z,
        bottom = camera.y + ((anchor.bottom - background.top) / scale) * camera.z
      const stageScale = stage.getBoundingClientRect().width / W
      const menuScale =
        workspace.app.getBoundingClientRect().width / workspace.app.offsetWidth / stageScale
      sessionMenu.style.transformOrigin = 'top left'
      sessionMenu.style.transform = 'scale(' + menuScale + ')'
      sessionMenu.style.left =
        clamp(
          right - sessionMenu.offsetWidth * menuScale,
          20,
          W - sessionMenu.offsetWidth * menuScale - 20
        ) + 'px'
      sessionMenu.style.top =
        clamp(bottom + 4 * menuScale, 20, H - sessionMenu.offsetHeight * menuScale - 20) + 'px'
      const submenu = sessionMenu.querySelector('.dv-session-submenu')
      if (submenu) {
        const exportRow = sessionMenu.querySelector('[data-target="export.menu"]')
        submenu.style.top = exportRow.offsetTop - 5 + 'px'
        const menuLeft = Number.parseFloat(sessionMenu.style.left)
        if (menuLeft + (sessionMenu.offsetWidth + 8 + submenu.offsetWidth) * menuScale > W - 20) {
          submenu.style.left = 'auto'
          submenu.style.right = 'calc(100% + 8px)'
        }
      }
    }
    state.modal = { kind, job_id: kind === 'remote-job' ? job.id : null, outside_camera: true }
    if (node) visible(brand, false)
  }
  function captionSync(t, s, local) {
    const hasCaptions = Array.isArray(C.captions) && C.captions.length > 0
    const item = hasCaptions
      ? C.captions.find((c) => t >= Number(c.start) && t < Number(c.end))
      : s.caption && local > 0.15 && local < durationOf(s) - 0.08
        ? { text: s.caption }
        : null
    visible(caption, !!item)
    if (!item) return
    if (Array.isArray(item.words) && item.words.length) {
      caption.replaceChildren(
        ...item.words.map((w) => {
          const token =
            typeof w === 'string'
              ? { text: w, start: item.start }
              : Array.isArray(w)
                ? { text: w[0], start: w[1] }
                : w
          return h(
            'span',
            { class: 'dv-word' + (t >= Number(token.start || 0) ? ' on' : '') },
            token.text
          )
        })
      )
    } else caption.textContent = item.text || ''
  }
  function framedConversationScroll(scene, bottomFollow) {
    const target = conversationTarget(scene)
    if (!target) return bottomFollow
    const threadBox = ws.thread.getBoundingClientRect()
    const scale = threadBox.width / ws.thread.offsetWidth
    if (!scale) return bottomFollow
    const top = (target.getBoundingClientRect().top - threadBox.top) / scale
    return clamp(top + Number(scene.conversation_focus.offset || 0), 0, bottomFollow)
  }
  function conversationScroll(s, t) {
    const bottomFollow = Math.max(0, ws.thread.scrollHeight - ws.scroller.clientHeight + 8)
    const local = t - Number(s.start || 0),
      focus = s.conversation_focus
    if (focus && local >= focus.at) {
      const framed = framedConversationScroll(s, bottomFollow)
      if (Number.isFinite(focus.until) && local >= focus.until) {
        return lerp(framed, bottomFollow, ease(part(local, focus.until, focus.until + 0.4)))
      }
      return lerp(bottomFollow, framed, ease(part(local, focus.at, focus.at + 0.4)))
    }
    const previous = scenes[scenes.indexOf(s) - 1]
    if (
      previous?.conversation_focus &&
      !Number.isFinite(previous.conversation_focus.until) &&
      local < 0.45
    ) {
      return lerp(
        framedConversationScroll(previous, bottomFollow),
        bottomFollow,
        ease(part(local, 0, 0.45))
      )
    }
    const plan = planForScene(s),
      lifecycle = planLifecycleAt(plan, t)
    if (!lifecycle || t < lifecycle.generationAt || t >= lifecycle.materializedAt + 0.3)
      return bottomFollow
    const entry = [...ws.thread.children].find(
      (node) => node.querySelector('.dv-native-plan-call')?.dataset.planId === plan.id
    )
    if (!entry) return bottomFollow
    const framed = Math.min(bottomFollow, Math.max(0, entry.offsetTop - 12))
    return t < lifecycle.materializedAt
      ? framed
      : lerp(
          framed,
          bottomFollow,
          ease(part(t, lifecycle.materializedAt, lifecycle.materializedAt + 0.3))
        )
  }
  function syncWorkspace(s, local) {
    targets.sessionMore.style.visibility = 'visible'
    stage.dataset.mixedChapter =
      s.kind === 'upload' || s.kind === 'prompt' || s.kind === 'controls' ? 'compose' : s.id
    const composerState = composeState(s, local)
    // Set the available width and composer height before measuring message contents.
    panelSync(s, local)
    // A long recorded cell or report must remain readable when exported or seeking backwards.
    const preview = panelProjection(s, local)
    const panelProgress = ease(
      part(preview.local, 1.5, Math.max(2, durationOf(preview.scene || s) - 1))
    )
    for (const pane of content.querySelectorAll('.dv-notebook-scroll, .dv-report')) {
      pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight) * panelProgress
      pane.scrollLeft = 0
    }
    planApproval(s, part(local, 0, durationOf(s)))
    composer.sync(composerState)
    computeSync(composerState)
    const composerSpace = Math.max(
      150,
      composer.composer.offsetHeight + (stage.dataset.mixedChapter === 'compose' ? 12 : 58) + 8
    )
    stage.style.setProperty('--dv-composer-space', composerSpace + 'px')
    renderHistory(now)
    planLoadingSync(planForScene(s), now)
    stage.style.setProperty('--dv-scroll', -conversationScroll(s, now) + 'px')
    return composerState
  }
  function seek(t) {
    now = clamp(t, 0, duration)
    const s = sceneAt(now),
      local = now - Number(s.start || 0),
      p = part(local, 0, durationOf(s))
    const planData = planForScene(s),
      planMode = planData.mode || 'omit',
      hasPlan = usablePlan(planData)
    const approval = approvalMode(planData)
    state = {
      t: now,
      scene_id: s.id,
      kind: s.kind,
      local,
      progress: p,
      permission: 'full',
      plan_mode: planMode,
      plan_id: planData.id,
      plan_approval_mode: approval,
      environment_mode: C.environment?.mode || 'local',
      camera_cut: s.camera_cut === true,
      camera_group: s.camera_group || null
    }
    const composerState = syncWorkspace(s, local)
    state.auto_review = Boolean(composerState.autoReview)
    state.compute_enabled = Boolean(composerState.computeEnabled)
    const lifecycle = planLifecycleAt(planData)
    state.plan_status =
      lifecycle?.phase ||
      (!hasPlan
        ? 'omitted'
        : approval === 'omit'
          ? 'not_recorded'
          : s.kind === 'plan'
            ? happened(s, 'approve_plan', local)
              ? 'approved'
              : 'awaiting_approval'
            : sceneEvents.some(
                  (e) =>
                    e.kind === 'plan' &&
                    e.plan_id === planData.id &&
                    e.approval_mode !== 'omit' &&
                    now >= e.done
                )
              ? 'approved'
              : 'not_requested')
    state.plan_lifecycle = lifecycle
    state.plan_progress = composerState.planProgress || null
    state.cancel_run = Boolean(composerState.runActive)
    const activity = agentActivityAt(planData, now)
    state.agent_activity = activity
      ? { phase: activity.phase, start: activity.start, end: activity.end }
      : null
    editorialSync(s, local)
    systemSync(s, local)
    const camera = lens(s, local)
    bg.style.transform = `translate(${camera.x.toFixed(3)}px,${camera.y.toFixed(3)}px) scale(${camera.z.toFixed(6)})`
    state.camera = camera
    positionPointer(s, local)
    captionSync(now, s, local)
    state.events = actionsFor(s)
      .filter((e) => e.at <= local)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        at: e.at,
        actor: e.actor,
        target: e.target,
        plane: e.plane
      }))
    const preview = panelProjection(s, local)
    state.preview = {
      mode: preview.mode,
      result_id: preview.result?.id || null,
      scene_id: preview.scene?.id || null
    }
    state.history = history
    state.active_result = ['artifact', 'notebook'].includes(preview.mode)
      ? preview.result?.id || null
      : null
    return state
  }
  window.__seek = seek
  window.__layout = () => ({ t: now, W, H, duration, fps: FPS, frames: Math.round(duration * FPS) })
  window.__demoViewState = () => ({ ...state, history: [...(state.history || [])] })
  window.__interactionPlan = () => ({
    clock: 'scene-local seconds',
    coordinates: '1920x1080 stage; workspace points precede camera projection',
    scenes: interactionTracks.map((track) => ({
      ...track,
      pointer_track: pointerPlan().find((item) => item.scene_id === track.scene_id)?.frames || [],
      missing_targets:
        pointerPlan().find((item) => item.scene_id === track.scene_id)?.missing_targets || []
    }))
  })
  window.__cameraPlan = () => {
    const tracks = cameraPlan()
    return {
      views: Object.keys(V),
      keyframes: tracks.flatMap((track) =>
        track.keyframes.map((frame, index) => ({
          t: track.start + frame.at,
          pose: { ...frame.pose },
          scene_id: track.scene_id,
          view: frame.view,
          camera_group: track.camera_group,
          cut: track.camera_cut && index === 0,
          intent: frame.intent
        }))
      ),
      scenes: tracks.map((track) => ({
        id: track.scene_id,
        start: track.start,
        duration: track.duration,
        camera_group: track.camera_group,
        camera_cut: track.camera_cut,
        camera_return: track.camera_return,
        intent: track.intent
      }))
    }
  }
  const preloads = [
    C.paper?.screenshot,
    ...(C.results || []).map((r) => (r.type === 'image' ? r.src : null)),
    'brand/logos/aipoch-logo-primary.svg',
    'brand/logos/open-science-lockup-black.svg',
    'brand/logos/open-science-symbol-black.svg'
  ]
    .filter(Boolean)
    .map(
      (src) =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = resolve
          img.onerror = () => reject(new Error('Could not decode required image: ' + src))
          img.src = safeAsset(src)
        })
    )
  window.__ready = Promise.all([document.fonts.ready, ...preloads]).then(() => {
    cameraPlan()
    pointerPlan()
    seek(Number(new URLSearchParams(location.search).get('t')) || 0)
    return { duration, fps: FPS, frames: Math.round(duration * FPS), W, H }
  })
  if (render) return
  const fit = () => {
    const scale = Math.max(0.01, Math.min((innerWidth - 24) / W, (innerHeight - 76) / H))
    stage.style.transform = `scale(${scale})`
    const root = document.getElementById('root')
    root.style.width = W * scale + 'px'
    root.style.height = H * scale + 'px'
  }
  window.addEventListener('resize', fit)
  fit()
  const controls = document.getElementById('controls'),
    play = h('button', {}, 'Play'),
    bar = h('input', {
      'aria-label': 'Playback position',
      type: 'range',
      min: 0,
      max: duration,
      step: 1 / FPS,
      value: 0
    }),
    clock = h('span', { class: 'dv-time' }, '0.00'),
    audio = C.audio ? new Audio(C.audio) : null
  let playing = false,
    started = 0,
    offset = 0,
    raf = 0
  const go = (t) => {
    seek(t)
    offset = now
    started = performance.now()
    if (audio) audio.currentTime = now
    bar.value = now
    clock.textContent = now.toFixed(2)
  }
  function loop() {
    if (!playing) return
    goPlayback(audio ? audio.currentTime : offset + (performance.now() - started) / 1000)
    if (now >= duration) {
      toggle()
      return
    }
    raf = requestAnimationFrame(loop)
  }
  function goPlayback(t) {
    seek(t)
    bar.value = now
    clock.textContent = now.toFixed(2)
  }
  async function toggle() {
    if (playing) {
      playing = false
      cancelAnimationFrame(raf)
      audio?.pause()
      play.textContent = 'Play'
      return
    }
    if (now >= duration) go(0)
    if (audio) {
      audio.currentTime = now
      try {
        await audio.play()
      } catch {
        play.textContent = 'Retry playback'
        return
      }
    }
    playing = true
    play.textContent = 'Pause'
    offset = now
    started = performance.now()
    loop()
  }
  play.onclick = toggle
  bar.oninput = () => go(+bar.value)
  controls.append(
    play,
    bar,
    clock,
    ...scenes.map((s) => {
      const b = h('button', { class: 'dv-scene-button' }, s.id)
      b.onclick = () => go(Number(s.start) + 0.01)
      return b
    })
  )
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault()
      toggle()
    } else if (e.code === 'ArrowRight') go(now + (e.shiftKey ? 1 : 1 / FPS))
    else if (e.code === 'ArrowLeft') go(now - (e.shiftKey ? 1 : 1 / FPS))
  })
})()
