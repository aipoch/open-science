/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
// Native Open-Science UI kit for videos — matches Open-Science 1.2.1.
// Rendered with the app's own compiled stylesheet (os-app.css = out/renderer/assets/client-D-WioDDF.css from Open-Science 1.2.1,
// with split-button-BHI1JYb3.css appended) and the exact Tailwind class names of the real React components (WorkspacePage,
// FilePreviewDialog, index, split-button and the streamdown markdown chunk). The class strings this file relies on, and how they
// were extracted, are in references/open-science-app/1.2.1/ (the 0.35.1 sources stay in references/open-science-app/renderer/,
// the 0.35.1 kit in ui/_archive-0.35.1/). Only layout glue that the app computes at runtime lives in os-kit.css.
;(() => {
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'html') el.innerHTML = v
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, x] of Object.entries(v))
          if (x != null) {
            if (p.startsWith('--')) el.style.setProperty(p, x)
            else el.style[p] = x
          }
      } else el.setAttribute(k, k === 'src' ? (window.VIDEO_ASSETS?.[v] ?? v) : v === true ? '' : v)
    }
    for (const c of kids.flat())
      if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c))
    return el
  }
  const cls = (...a) => a.filter(Boolean).join(' ')

  // lucide icons (ISC), copied from the icon nodes bundled in Open-Science 1.2.1's renderer (createLucideIcon calls)
  const P = {
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    atSign: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    atom: '<circle cx="12" cy="12" r="1"/><path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/><path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/>',
    bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    bookOpen:
      '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    circleAlert:
      '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    circleGauge:
      '<path d="M15.6 2.7a10 10 0 1 0 5.7 5.7"/><circle cx="12" cy="12" r="2"/><path d="M13.4 10.6 19 5"/>',
    circleMinus: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
    circlePlus: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    circleQuestionMark:
      '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    cpu: '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
    dna: '<path d="m10 16 1.5 1.5"/><path d="m14 8-1.5-1.5"/><path d="M15 2c-1.798 1.998-2.518 3.995-2.807 5.993"/><path d="m16.5 10.5 1 1"/><path d="m17 6-2.891-2.891"/><path d="M2 15c6.667-6 13.333 0 20-6"/><path d="m20 9 .891.891"/><path d="M3.109 14.109 4 15"/><path d="m6.5 12.5 1 1"/><path d="m7 18 2.891 2.891"/><path d="M9 22c1.798-1.998 2.518-3.995 2.807-5.993"/>',
    download:
      '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    earth:
      '<path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"/><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"/><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"/><circle cx="12" cy="12" r="10"/>',
    ellipsis:
      '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
    fileArchive:
      '<path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/>',
    fileBraces:
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
    fileCodeCorner:
      '<path d="M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m5 16-3 3 3 3"/><path d="m9 22 3-3-3-3"/>',
    fileCog:
      '<path d="M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z"/><path d="M20 8v12a2 2 0 0 1-2 2h-4.182"/><path d="m3.305 19.53.923-.382"/><path d="M4 10.592V4a2 2 0 0 1 2-2h8"/><path d="m4.228 16.852-.924-.383"/><path d="m5.852 15.228-.383-.923"/><path d="m5.852 20.772-.383.924"/><path d="m8.148 15.228.383-.923"/><path d="m8.53 21.696-.382-.924"/><path d="m9.773 16.852.922-.383"/><path d="m9.773 19.148.922.383"/><circle cx="7" cy="18" r="3"/>',
    fileImage:
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>',
    filePen:
      '<path d="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"/>',
    filePenLine:
      '<path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/>',
    fileSpreadsheet:
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
    fileTerminal:
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m8 16 2-2-2-2"/><path d="M12 18h4"/>',
    fileText:
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    fileTypeCorner:
      '<path d="M12 22h6a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v6"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M3 16v-1.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V16"/><path d="M6 22h2"/><path d="M7 14v8"/>',
    files:
      '<path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/><path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z"/><path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1"/>',
    folderOpen:
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    gitBranch:
      '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
    listChecks:
      '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
    loaderCircle: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    maximize2:
      '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
    menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
    messageSquare:
      '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>',
    minimize2:
      '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
    packageOpen:
      '<path d="M12 22v-9"/><path d="M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z"/><path d="M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13"/><path d="M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z"/>',
    packagePlus:
      '<path d="M12 22V12"/><path d="M16 17h6"/><path d="M19 14v6"/><path d="M21 10.535V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.675-.955"/><path d="M3.29 7 12 12l8.71-5"/><path d="m7.5 4.27 8.997 5.148"/>',
    panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    presentation:
      '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    server:
      '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    settings:
      '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    shieldCheck:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    sigma:
      '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
    slidersHorizontal:
      '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
    sparkles:
      '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
    square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    stethoscope:
      '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
    store:
      '<path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/>',
    terminal: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
    toolbox:
      '<path d="M16 12v4"/><path d="M16 6a2 2 0 0 1 1.414.586l4 4A2 2 0 0 1 22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 .586-1.414l4-4A2 2 0 0 1 8 6z"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M2 14h20"/><path d="M8 12v4"/>',
    undo2:
      '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    vectorSquare:
      '<path d="M19.5 7a24 24 0 0 1 0 10"/><path d="M4.5 7a24 24 0 0 0 0 10"/><path d="M7 19.5a24 24 0 0 0 10 0"/><path d="M7 4.5a24 24 0 0 1 10 0"/><rect x="17" y="17" width="5" height="5" rx="1"/><rect x="17" y="2" width="5" height="5" rx="1"/><rect x="2" y="17" width="5" height="5" rx="1"/><rect x="2" y="2" width="5" height="5" rx="1"/>',
    wandSparkles:
      '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
    wrench:
      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'
  }
  // names used by the 0.35.1 kit and its callers
  Object.assign(P, {
    loader: P.loaderCircle,
    more: P.ellipsis,
    msg: P.messageSquare,
    book: P.bookOpen,
    fileJson: P.fileBraces
  })
  const icon = (n, c = 'size-4', sw = 2) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    s.setAttribute('viewBox', '0 0 24 24')
    s.setAttribute('fill', 'none')
    s.setAttribute('stroke', 'currentColor')
    s.setAttribute('stroke-width', sw)
    s.setAttribute('stroke-linecap', 'round')
    s.setAttribute('stroke-linejoin', 'round')
    s.setAttribute('class', c)
    s.setAttribute('aria-hidden', 'true')
    s.innerHTML = P[n] || P.file
    return s
  }

  // ---- file names and file-type icons (ExtensionPreservingFileName, FileTypeIcon) ----
  const splitName = (name, compact) => {
    const k = name.lastIndexOf('.'),
      base = k > 0 ? name.slice(0, k) : name,
      ext = k > 0 ? name.slice(k) : ''
    const ch = Array.from(base)
    if (compact && ch.length >= 24)
      return { head: ch.slice(0, 3).join(''), tail: ch.slice(-1).join(''), ext, abbr: true }
    return { head: ch.slice(0, -5).join(''), tail: ch.slice(-5).join(''), ext, abbr: false }
  }
  // compact: the generated-file card rule (head 3 + "..." + tail 1 once the basename has 24+ characters and does not fit)
  function fileName(name, c = '', compact = false) {
    const p = splitName(name, compact)
    return h(
      'span',
      {
        'data-testid': 'file-name-root',
        class: cls(
          'relative flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap',
          c
        )
      },
      h(
        'span',
        {
          'data-testid': 'file-name-head',
          class: cls('min-w-0', p.abbr ? 'shrink-0' : 'shrink truncate')
        },
        p.head
      ),
      p.abbr ? h('span', { 'data-testid': 'file-name-ellipsis', class: 'shrink-0' }, '...') : null,
      p.tail ? h('span', { 'data-testid': 'file-name-tail', class: 'shrink-0' }, p.tail) : null,
      p.ext
        ? h(
            'span',
            {
              'data-testid': 'file-name-extension',
              class: 'max-w-[50%] shrink-0 overflow-hidden text-ellipsis'
            },
            p.ext
          )
        : null
    )
  }
  const EXT_ICON = (ext) => {
    if (ext === 'svg') return 'vectorSquare'
    if (/^(avif|gif|jpe?g|png|tiff?|webp)$/.test(ext)) return 'fileImage'
    if (/^(7z|bz2|gz|rar|tar|zip)$/.test(ext)) return 'fileArchive'
    if (ext === 'pdf') return 'fileTypeCorner'
    if (/^docx?$/.test(ext)) return 'filePenLine'
    if (/^(csv|tsv|xlsx?)$/.test(ext)) return 'fileSpreadsheet'
    if (/^pptx?$/.test(ext)) return 'presentation'
    if (ext === 'ipynb') return 'bookOpen'
    if (/^(conf|config|ini|toml|ya?ml)$/.test(ext)) return 'fileCog'
    if (/^(json|jsonl|geojson)$/.test(ext)) return 'fileBraces'
    if (/^(pdb|cif|mol2?|sdf|xyz)$/.test(ext)) return 'atom'
    if (/^(fa|fasta|fna|faa|gb|gbk)$/.test(ext)) return 'dna'
    if (/^pyw?$/.test(ext)) return 'fileTerminal'
    if (/^r$/i.test(ext)) return 'sigma'
    if (
      /^(html?|js|mjs|ts|tsx|jsx|css|c|cc|cpp|h|java|go|rs|sh|sql|m|jl|rb|php|swift|kt|scala|lua|pl|xml)$/.test(
        ext
      )
    )
      return 'fileCodeCorner'
    if (/^(txt|md|markdown|log|rst|tex|nwk|tree|treefile|iqtree|state)$/.test(ext))
      return 'fileText'
    return 'file'
  }
  const fileTypeIcon = (name, c = '') =>
    h(
      'span',
      {
        'aria-hidden': 'true',
        class: cls(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border-200/60 bg-bg-200 p-0.5 text-text-300',
          c
        )
      },
      icon(EXT_ICON((name.split('.').pop() || '').toLowerCase()), 'size-full', 2.4)
    )

  // ---- markdown -> elements, rendered like the app's AgentMarkdown (streamdown in static mode inside "prose prose-sm") ----
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const attr = (s) => esc(s).replace(/"/g, '&quot;')
  const SD = {
    code: 'class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm" data-streamdown="inline-code"',
    strong: 'class="font-semibold" data-streamdown="strong"',
    a: 'class="wrap-anywhere font-medium text-primary underline" data-streamdown="link"',
    ul: 'class="list-inside list-disc whitespace-normal [li_&amp;]:pl-6" data-streamdown="unordered-list"',
    ol: 'class="list-inside list-decimal whitespace-normal [li_&amp;]:pl-6" data-streamdown="ordered-list"',
    li: 'class="py-1 [&amp;&gt;p]:inline" data-streamdown="list-item"',
    h: { 1: 'text-3xl', 2: 'text-2xl', 3: 'text-xl', 4: 'text-lg', 5: 'text-base', 6: 'text-sm' }
  }
  const isFileRef = (href) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)
  function inline(s, opt) {
    const codes = []
    let t = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    t = t
      .replace(/\*\*([^*]+)\*\*/g, `<span ${SD.strong}>$1</span>`)
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) =>
      // the app shows a link to a file it cannot resolve as "name (`path`)" (SessionMessageMarkdown ArtifactLink); opt.links = 'unresolved'
      opt.links === 'unresolved' && isFileRef(href)
        ? `<span>${txt} (<code>${href}</code>)</span>`
        : `<a ${SD.a} href="#">${txt}</a>`
    )
    // eslint-disable-next-line no-control-regex -- Restore the inline code placeholders inserted above.
    return t.replace(/\u0000(\d+)\u0000/g, (_, k) => `<code ${SD.code}>${codes[+k]}</code>`)
  }
  function mdHtml(src, opt = {}) {
    const out = [],
      lines = src.split('\n')
    const BLOCK = /^(#{1,6} |- |\* |\||```|\d+\. |!\[)/
    for (let i = 0; i < lines.length;) {
      const l = lines[i]
      if (l.startsWith('```')) {
        const b = []
        for (i++; i < lines.length && !lines[i].startsWith('```'); i++) b.push(esc(lines[i]))
        out.push(`<pre><code>${b.join('\n')}</code></pre>`)
        i++
      } else if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(l)) {
        const m = l.match(/^!\[([^\]]*)\]\(([^)]+)\)/)
        out.push(
          `<p><img src="${attr(window.VIDEO_ASSETS?.[m[2]] ?? '')}" alt="${attr(m[1])}" class="osk-md-img"></p>`
        )
        i++
      } else if (/^#{1,6} /.test(l)) {
        const n = l.match(/^#+/)[0].length
        out.push(
          `<h${n} class="mt-6 mb-2 font-semibold ${SD.h[n]}" data-streamdown="heading-${n}">${inline(l.slice(n + 1), opt)}</h${n}>`
        )
        i++
      } else if (/^\d+\. /.test(l)) {
        const it = []
        for (; i < lines.length && /^\d+\. /.test(lines[i]); i++)
          it.push(`<li ${SD.li}>${inline(lines[i].replace(/^\d+\. /, ''), opt)}</li>`)
        out.push(`<ol ${SD.ol}>${it.join('')}</ol>`)
      } else if (/^[-*] /.test(l)) {
        const it = []
        for (; i < lines.length && /^[-*] /.test(lines[i]); i++)
          it.push(`<li ${SD.li}>${inline(lines[i].slice(2), opt)}</li>`)
        out.push(`<ul ${SD.ul}>${it.join('')}</ul>`)
      } else if (l.startsWith('|')) {
        const rows = []
        for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i])
        const cells = (r) =>
          r
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim())
        out.push(
          `<div class="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2" data-streamdown="table-wrapper"><div class="border-collapse overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">` +
            `<table class="w-full divide-y divide-border" data-streamdown="table"><thead class="bg-muted/80" data-streamdown="table-header"><tr class="border-border" data-streamdown="table-row">${cells(
              rows[0]
            )
              .map(
                (c) =>
                  `<th class="whitespace-nowrap px-4 py-2 text-left font-semibold text-sm" data-streamdown="table-header-cell">${inline(c, opt)}</th>`
              )
              .join('')}</tr></thead>` +
            `<tbody class="divide-y divide-border" data-streamdown="table-body">${rows
              .slice(2)
              .map(
                (r) =>
                  `<tr class="border-border" data-streamdown="table-row">${cells(r)
                    .map(
                      (c) =>
                        `<td class="px-4 py-2 text-sm" data-streamdown="table-cell">${inline(c, opt)}</td>`
                    )
                    .join('')}</tr>`
              )
              .join('')}</tbody></table></div></div>`
        )
      } else if (!l.trim()) i++
      else {
        const b = [inline(l, opt)]
        for (i++; i < lines.length && lines[i].trim() && !BLOCK.test(lines[i]); i++)
          b.push(inline(lines[i], opt))
        out.push(`<p>${b.join(' ')}</p>`)
      }
    }
    return out.join('')
  }
  // opt.links: 'link' (default) | 'unresolved' (relative file links render as "name (`path`)", as the app does when it can't resolve them)
  const markdown = (src, opt = {}) =>
    h(
      'div',
      { class: 'agent-markdown-root max-w-full min-w-0' },
      h('div', {
        class:
          'space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 agent-markdown prose prose-sm prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2',
        dir: 'ltr',
        html: mdHtml(src, opt)
      })
    )

  // ---- buttons (buttonVariants from the app) ----
  const BTN =
    "group/button inline-flex shrink-0 touch-manipulation items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
  const VAR = {
    default: 'bg-primary text-primary-foreground',
    outline: 'border-border bg-card text-foreground',
    ghost: '',
    secondary: 'bg-secondary text-secondary-foreground',
    destructive: 'bg-destructive/10 text-destructive',
    link: 'text-primary underline-offset-4'
  }
  const SIZE = {
    default: 'h-8 gap-1.5 px-2.5',
    xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
    sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
    lg: 'h-9 gap-1.5 px-2.5',
    icon: 'size-8',
    'icon-xs': "size-6 rounded-[min(var(--radius-md),10px)] [&_svg:not([class*='size-'])]:size-3",
    'icon-sm': 'size-7 rounded-[min(var(--radius-md),12px)]',
    'icon-lg': 'size-9'
  }
  const button = (label, variant = 'default', size = 'default', extra = '') =>
    h(
      'button',
      {
        type: 'button',
        'data-slot': 'button',
        'data-variant': variant,
        'data-size': size,
        class: cls(BTN, VAR[variant], SIZE[size], extra)
      },
      label
    )

  // ---- sidebar (WorkspaceSidebarView) ----
  const DOT = {
    idle: 'border border-text-100 bg-transparent',
    done: 'border border-text-100 bg-transparent',
    running: 'bg-session-running ring-2 ring-session-running/20',
    waiting: 'bg-session-waiting ring-2 ring-session-waiting/25',
    error: 'bg-destructive'
  }
  function sidebar(o) {
    const NAV =
      'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 transition-none'
    const navRow = (ic, label, pressed) =>
      h(
        'div',
        { class: 'flex h-9 items-center gap-1 px-1.5' },
        h(
          'button',
          { type: 'button', class: cls(NAV, pressed && 'bg-bg-300') },
          ic === 'store'
            ? icon('store', 'size-3.5 shrink-0')
            : h(
                'span',
                {
                  class: 'flex size-3.5 shrink-0 items-center justify-center',
                  'aria-hidden': 'true'
                },
                icon(ic, 'size-3.5')
              ),
          h('span', { class: ic === 'store' ? 'min-w-0 truncate' : null }, label)
        )
      )
    const sections = (o.sections || []).map((sec) =>
      h(
        'details',
        { open: true, 'data-section': sec.label, class: 'group/section' },
        h(
          'summary',
          {
            class:
              'flex cursor-pointer list-none items-center gap-1 px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground outline-none [&::-webkit-details-marker]:hidden'
          },
          icon('chevronRight', 'size-3 shrink-0 rotate-90'),
          h('span', {}, sec.label)
        ),
        sec.items.map((s) => {
          const st = DOT[s.status] ? s.status : 'idle'
          const row = h(
            'div',
            {
              class: cls(
                'osk-session-row group relative mx-1.5 select-none rounded-md px-2.5 py-1.5 text-sm text-text-000 transition-none',
                s.active && 'bg-bg-300 text-text-000'
              )
            },
            h(
              'div',
              { class: 'flex w-full min-w-0 items-center' },
              h(
                'button',
                {
                  type: 'button',
                  'data-slot': 'session-open-button',
                  class:
                    'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left after:absolute after:inset-0 after:rounded-[inherit]',
                  'aria-current': s.active ? 'page' : null
                },
                h(
                  'span',
                  {
                    class: 'inline-flex size-3 shrink-0 items-center justify-center',
                    'aria-hidden': 'true'
                  },
                  h('span', { class: cls('size-[7px] shrink-0 rounded-full', DOT[st]) })
                ),
                h(
                  'span',
                  {
                    class: cls(
                      'min-w-0 flex-1 truncate',
                      sec.label === 'Active' && st !== 'idle' && st !== 'done' && 'font-semibold'
                    )
                  },
                  s.title
                ),
                s.imported
                  ? h(
                      'span',
                      {
                        role: 'img',
                        'aria-label': 'Read-only',
                        class:
                          'relative z-[2] inline-flex size-4 shrink-0 items-center justify-center text-text-200'
                      },
                      icon('lock', 'size-3.5', 1.75)
                    )
                  : null
              ),
              h('span', {
                'aria-hidden': 'true',
                class: cls(
                  'pointer-events-none absolute inset-y-0 right-0 z-[1] w-12 rounded-r-md bg-gradient-to-r from-transparent',
                  s.active ? 'via-bg-300 to-bg-300' : 'via-rail-card-bg to-rail-card-bg'
                )
              })
            )
          )
          s.el = row
          return row
        })
      )
    )
    return h(
      'aside',
      {
        'aria-label': 'Workspace navigation',
        class: 'osk-sidebar z-10 flex h-full w-full min-w-0 flex-col overflow-hidden'
      },
      h(
        'div',
        { class: 'm-[0.7px] flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card' },
        h(
          'div',
          { class: 'px-3 pt-3' },
          h(
            'div',
            { class: 'flex items-center' },
            h(
              'button',
              {
                type: 'button',
                class:
                  'grid h-7 w-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-none'
              },
              icon('chevronLeft', 'size-4')
            ),
            h(
              'button',
              {
                type: 'button',
                class:
                  'osk-project flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-left font-serif text-[15px] font-bold tracking-[-0.02em] text-text-000 transition-none'
              },
              h('span', { class: 'min-w-0 flex-1 truncate' }, o.project),
              icon('chevronDown', 'size-3.5 shrink-0 text-text-100')
            ),
            h(
              'button',
              {
                type: 'button',
                'data-testid': 'workspace-sidebar-toggle',
                class:
                  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-action-panel-toggle transition-none'
              },
              icon('panelLeft', 'size-4')
            )
          )
        ),
        h(
          'nav',
          { 'aria-label': 'Sessions', class: 'osk-nav flex min-h-0 flex-1 flex-col' },
          navRow('plus', 'New'),
          navRow('toolbox', 'Customize'),
          navRow('files', 'Files', o.filesOpen),
          navRow('cpu', 'Compute'),
          navRow('bookOpen', 'Library'),
          navRow('store', 'Resource center'),
          h('div', { class: 'mx-2 my-1 h-px bg-border-300/15' }),
          h(
            'div',
            { class: 'osk-sessions scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto py-1' },
            sections
          ),
          h(
            'div',
            { class: 'osk-rail-foot relative shrink-0 px-2 pt-2' },
            h('div', {
              'aria-hidden': 'true',
              class:
                'pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0'
            }),
            h(
              'div',
              { class: 'flex items-center gap-1 pb-2' },
              h(
                'button',
                {
                  type: 'button',
                  'aria-label': 'Settings',
                  class:
                    'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-text-300 transition-none'
                },
                icon('settings', 'size-4')
              ),
              h(
                'button',
                {
                  type: 'button',
                  'aria-label': 'Notifications',
                  class: 'inline-flex size-8 items-center justify-center rounded-md text-text-300'
                },
                icon('bell', 'size-4')
              )
            )
          )
        )
      )
    )
  }

  // ---- tool group (WorkspaceActivityGroupSurface + WorkspaceToolActivityRowButton) ----
  const STATUS_ICON = {
    running: 'loaderCircle',
    failed: 'circleAlert',
    cancelled: 'circleMinus',
    completed: 'check'
  }
  const statusIcon = (st, c = 'size-3.5 shrink-0') =>
    icon(STATUS_ICON[st] || 'check', cls(c, st === 'running' && 'osk-spin'), 2.2)
  // g = { title, meta, expanded, status?, rows: [{ label, detail, meta, status? }] }. Rows show the status icon, as in 1.2.1 (r.icon is ignored).
  function toolGroup(g) {
    const rows = (g.rows || []).map((r) =>
      h(
        'div',
        { class: 'w-full overflow-hidden' },
        h(
          'button',
          {
            type: 'button',
            'data-testid': 'tool-chip',
            class: cls(
              'osk-tool-row flex w-full min-h-[44px] items-start gap-2 rounded-lg py-2 pl-1.5 pr-2.5 text-[13px] md:min-h-0 md:items-center md:py-[5px]',
              r.status === 'failed'
                ? 'text-danger-000'
                : r.status === 'running'
                  ? 'text-text-000'
                  : 'text-text-100'
            )
          },
          h(
            'span',
            { class: 'mt-0.5 inline-flex shrink-0 items-center md:mt-0' },
            statusIcon(r.status)
          ),
          h(
            'span',
            { class: 'min-w-0 flex-1 text-left md:flex md:items-center md:gap-2' },
            h('span', { class: 'block min-w-0 truncate text-text-000' }, r.label),
            r.detail ? h('span', { class: 'hidden shrink-0 text-text-300 md:inline' }, '·') : null,
            r.detail
              ? h(
                  'span',
                  { class: 'mt-0.5 block min-w-0 truncate font-normal text-text-100 md:mt-0' },
                  r.detail
                )
              : null
          ),
          r.meta
            ? h(
                'span',
                {
                  class:
                    'mt-0.5 shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-100 md:mt-0'
                },
                r.meta
              )
            : null
        )
      )
    )
    return h(
      'div',
      {
        class: 'w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1',
        'data-testid': 'tool-group'
      },
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': g.expanded ? 'true' : 'false',
          'data-testid': 'tool-group-header',
          class: 'flex w-full items-center gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px]'
        },
        statusIcon(g.status),
        h('span', { class: 'min-w-0 truncate text-left font-medium text-text-000' }, g.title),
        h(
          'span',
          { class: 'ml-auto shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-000' },
          g.meta
        ),
        h(
          'span',
          {
            class: cls(
              'inline-flex w-4 shrink-0 items-center justify-center text-text-100',
              g.expanded && 'rotate-90'
            )
          },
          icon('chevronRight', 'size-3.5', 2.2)
        )
      ),
      g.expanded ? h('div', { class: 'pb-0.5' }, rows) : null
    )
  }

  // ---- generated files (MessageArtifactList + GeneratedFileCard) ----
  const CARD =
    'h-[82px] w-[128px] shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border-200 bg-bg-000 text-left text-text-000 shadow-none'
  const previewLines = (s) =>
    s
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(0, 4)
      .map((l) => l.trim())
      .join('\n')
  // a = { name, size, preview?: text (first lines shown), img?: url, ext?, kind? }
  function generatedCard(a) {
    const ext = (a.ext || (a.name.includes('.') ? a.name.split('.').pop() : '') || 'file')
      .toUpperCase()
      .slice(0, 6)
    const thumb = a.img
      ? h('img', { src: a.img, alt: '', class: 'block size-full object-cover' })
      : h(
          'div',
          { class: 'size-full overflow-hidden bg-bg-000 px-2 py-1.5' },
          a.preview
            ? h(
                'pre',
                {
                  class:
                    'm-0 line-clamp-4 whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.15] text-text-000'
                },
                previewLines(a.preview)
              )
            : h('span', { class: 'text-[11px] font-semibold text-text-000' }, ext)
        )
    return h(
      'button',
      {
        type: 'button',
        class: cls('osk-art-card group flex min-w-0 flex-col', CARD),
        title: a.name
      },
      h(
        'div',
        { class: 'relative h-[56px] w-full overflow-hidden bg-bg-200' },
        h('span', { class: 'block size-full' }, thumb)
      ),
      h(
        'div',
        { class: 'flex min-w-0 flex-1 items-center px-1.5' },
        fileName(a.name, 'flex-1 text-[12px] leading-5', true),
        a.size ? h('span', { class: 'ml-1 shrink-0 text-[11px] text-text-000' }, a.size) : null
      )
    )
  }
  function generated(list) {
    return h(
      'div',
      { class: 'mt-3 border-t border-border-200 pt-3' },
      h(
        'div',
        { class: 'mb-2 text-[11px] font-medium uppercase text-text-300' },
        `GENERATED · ${list.length}`
      ),
      h(
        'div',
        { class: 'osk-art-grid grid max-w-full grid-cols-[repeat(auto-fill,128px)] gap-2 pb-1' },
        list.slice(0, 5).map(generatedCard),
        list.length > 5
          ? h(
              'button',
              {
                type: 'button',
                class: cls(
                  'osk-art-more flex items-center justify-center text-[13px] font-semibold',
                  CARD
                )
              },
              `+${list.length - 5} more`
            )
          : null
      )
    )
  }

  // ---- assistant footer (WorkspaceAssistantTurnCompletion) ----
  // f: string (shown as the timestamp text, e.g. "Completed Nov 12, 8:59 AM") or { completed, elapsed, calls, actions }
  function turnFooter(f) {
    const o = typeof f === 'string' ? { text: f, actions: true } : f
    const ACT =
      'flex size-6 touch-manipulation items-center justify-center rounded-md text-text-300'
    return h(
      'div',
      {
        'data-slot': 'assistant-message-footer',
        class:
          'osk-turn-footer mt-3 flex items-center gap-x-3 whitespace-nowrap text-[11px] leading-4 text-text-000/70 tabular-nums'
      },
      o.actions !== false
        ? h(
            'div',
            { 'data-slot': 'assistant-message-actions', class: 'flex items-center gap-0.5' },
            h(
              'button',
              { type: 'button', 'aria-label': 'Copy message', class: ACT },
              h('span', { class: 'button-feedback' }, icon('copy', 'size-3.5'))
            ),
            h(
              'button',
              { type: 'button', 'aria-label': 'Branch in new session', class: ACT },
              icon('gitBranch', 'size-3.5')
            )
          )
        : null,
      o.text != null
        ? h('time', { class: 'rounded-sm' }, o.text)
        : o.completed
          ? h('time', { class: 'rounded-sm' }, `Completed ${o.completed}`)
          : null,
      o.elapsed
        ? h(
            'span',
            { 'data-slot': 'assistant-message-elapsed-segment', class: 'whitespace-nowrap' },
            h('span', {}, `Elapsed ${o.elapsed}`)
          )
        : null,
      o.calls
        ? h(
            'span',
            { 'data-slot': 'turn-token-usage', class: 'inline-flex whitespace-nowrap' },
            h(
              'button',
              {
                type: 'button',
                class:
                  'inline-flex touch-manipulation items-center gap-1 border-b border-dashed border-current pb-px leading-none'
              },
              icon('circleGauge', 'size-3 shrink-0'),
              'Calls'
            )
          )
        : null
    )
  }

  // ---- messages (WorkspaceMessageItem) ----
  // m = { i, role, md, steps?, generated?, completed? (string|object), sent?, links? }
  // User text is shown as plain text, as in the app (pass m.markdown = true to render it as markdown instead).
  function message(m) {
    if (m.role === 'user') {
      return h(
        'div',
        {
          class: 'osk-msg msg osk-item min-w-0 px-4 pb-1 pt-5 md:px-6',
          'data-i': m.i,
          'data-message-id': m.i
        },
        h(
          'div',
          { class: 'group flex flex-col items-end' },
          h(
            'div',
            { class: 'flex w-full max-w-full items-center justify-end gap-1' },
            h(
              'div',
              {
                'data-slot': 'user-message-bubble',
                class:
                  'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'
              },
              m.markdown
                ? markdown(m.md || '', m)
                : h(
                    'p',
                    { class: 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' },
                    m.md || m.text || ''
                  )
            )
          ),
          m.sent
            ? h(
                'div',
                {
                  'data-slot': 'user-message-footer',
                  class:
                    'mt-1 flex min-h-6 w-full flex-wrap items-center justify-end gap-x-2 text-[11px] leading-4 text-text-000/70 tabular-nums'
                },
                h('time', { class: 'rounded-sm' }, `Sent ${m.sent}`)
              )
            : null
        )
      )
    }
    return h(
      'div',
      {
        class: 'osk-msg msg osk-item min-w-0 px-4 pb-1 pt-5 md:px-6',
        'data-i': m.i,
        'data-message-id': m.i
      },
      h(
        'div',
        {
          class:
            'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px] select-text overflow-visible'
        },
        m.md ? markdown(m.md, m) : null,
        m.steps ? h('div', { class: 'osk-group-wrap' }, toolGroup(m.steps)) : null,
        m.generated && m.generated.length ? generated(m.generated) : null,
        m.completed ? turnFooter(m.completed) : null
      )
    )
  }

  // ---- composer (conversation-composer-dock + ordinary-composer-form) ----
  // composer(compact, host) as in 0.35.1, or composer({ compact, draft, placeholder, plan: { step, total, running }, notebook,
  //   context: percent, model, effort, running, controlsDot, draftEnd }). host is accepted but not shown: 1.2.1's composer shows
  //   compute targets only as a server badge (opts.computeTargets = n).
  function composer(arg, host) {
    const o = typeof arg === 'object' && arg ? arg : { compact: !!arg, host }
    const ICONBTN = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300'
    const TRIG =
      'relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-text-300'
    const placeholder =
      o.placeholder ||
      (o.compact
        ? 'Ask anything'
        : 'Ask anything — / skills · @ files · # sessions · ⌘K search · ↑↓ history')
    const editor = h(
      'div',
      {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Ask anything',
        class: cls(
          'osk-composer-input min-h-[36px] max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent py-1.5 text-[15px] leading-relaxed text-text-000 outline-none',
          o.draft && o.draftEnd !== false && 'osk-scroll-end'
        )
      },
      o.draft ? h('div', {}, o.draft) : null
    )
    const statusRow =
      o.plan || o.notebook
        ? h(
            'div',
            {
              class:
                'osk-status-row relative flex min-w-0 px-2 relative -mb-8 min-h-[68px] items-start rounded-2xl bg-bg-200 pt-1'
            },
            o.plan
              ? button(
                  [
                    o.plan.running
                      ? h('span', {
                          'aria-hidden': 'true',
                          class: 'size-1.5 shrink-0 rounded-full bg-primary'
                        })
                      : null,
                    icon('listChecks', 'size-3.5'),
                    `step ${o.plan.step}/${o.plan.total}`,
                    o.plan.running
                      ? h(
                          'span',
                          { class: 'font-medium text-primary' },
                          `· ${o.plan.running} running`
                        )
                      : null
                  ],
                  'ghost',
                  'sm',
                  'text-[12px] font-normal text-text-100'
                )
              : null,
            o.notebook
              ? h(
                  'button',
                  {
                    type: 'button',
                    class:
                      'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-normal text-text-100'
                  },
                  icon('bookOpen', 'size-3.5'),
                  typeof o.notebook === 'string' ? o.notebook : 'Notebook'
                )
              : null,
            h('div', { class: 'flex-1' })
          )
        : null
    const canSend = !!o.draft
    const send = o.running
      ? h(
          'div',
          {
            role: 'group',
            'data-split-group': '',
            'data-testid': 'composer-running-control-slot',
            class: cls(
              'split-button-group flex w-16 shrink-0 justify-end',
              canSend ? 'bg-primary' : 'bg-bg-200'
            )
          },
          h(
            'button',
            {
              type: 'button',
              'data-slot': 'button',
              'data-split-primary': '',
              class: cls(
                BTN,
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                canSend ? 'bg-primary text-primary-foreground' : 'bg-bg-200 text-text-000'
              )
            },
            canSend ? icon('arrowUp', 'size-4', 2.2) : icon('square', 'size-3.5', 2.2)
          ),
          h(
            'span',
            { class: 'inline-flex' },
            h(
              'button',
              {
                type: 'button',
                'data-slot': 'button',
                'data-split-trigger': '',
                'data-state': 'closed',
                class: cls(
                  BTN,
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                  canSend ? 'text-primary-foreground' : 'text-text-300'
                )
              },
              icon('chevronDown', 'size-3.5')
            )
          )
        )
      : h(
          'div',
          {
            role: 'group',
            'aria-label': 'Send message options',
            'data-split-group': '',
            class: cls(
              'split-button-group osk-send flex rounded-md bg-primary text-primary-foreground',
              !canSend && 'opacity-50'
            )
          },
          h(
            'button',
            {
              type: 'button',
              'data-slot': 'button',
              'data-split-primary': '',
              class: cls(
                BTN,
                'relative h-8 w-8 border-0 bg-transparent bg-clip-border text-primary-foreground'
              )
            },
            icon('arrowUp', 'size-4', 2.2)
          ),
          h(
            'button',
            {
              type: 'button',
              'data-slot': 'button',
              'data-split-trigger': '',
              'data-state': 'closed',
              class: cls(
                BTN,
                'relative h-8 w-8 border-0 bg-transparent bg-clip-border text-primary-foreground'
              )
            },
            icon('chevronDown', 'size-3.5', 2.2)
          )
        )
    const form = h(
      'form',
      {
        'data-testid': 'ordinary-composer-form',
        class:
          'osk-composer-card relative z-10 flex flex-col gap-2 rounded-2xl border border-border-200 bg-bg-000 px-3 py-2'
      },
      h(
        'div',
        { class: 'relative min-w-0 flex-1' },
        h(
          'div',
          { class: 'relative min-w-0 pr-7' },
          editor,
          o.draft
            ? null
            : h(
                'div',
                {
                  'aria-hidden': 'true',
                  class:
                    'osk-placeholder pointer-events-none absolute inset-x-0 top-0 truncate py-1.5 pr-7 text-[15px] leading-relaxed text-muted-foreground'
                },
                placeholder
              ),
          h(
            'button',
            {
              type: 'button',
              'data-slot': 'button',
              'aria-label': 'Input help',
              class: cls(
                BTN,
                SIZE['icon-xs'],
                'absolute right-0 top-0 size-6 text-muted-foreground'
              )
            },
            icon('circleQuestionMark', 'size-3.5')
          )
        )
      ),
      h(
        'div',
        { class: 'osk-composer-tools flex flex-wrap items-center gap-1' },
        h(
          'button',
          { type: 'button', 'data-testid': 'composer-plus-trigger', class: ICONBTN },
          icon('plus', 'size-4')
        ),
        h(
          'button',
          { type: 'button', 'data-testid': 'composer-controls-trigger', class: TRIG },
          icon('slidersHorizontal', 'size-4 shrink-0'),
          o.controlsDot
            ? h('span', {
                'data-testid': 'controls-nondefault-dot',
                'aria-hidden': 'true',
                class: 'absolute right-1 top-1 size-1.5 rounded-full bg-primary ring-1 ring-bg-000'
              })
            : null
        ),
        h(
          'button',
          { type: 'button', 'data-slot': 'button', class: cls(BTN, ICONBTN, 'group/optimize') },
          icon('wandSparkles', 'size-4')
        ),
        o.computeTargets
          ? h(
              'button',
              { type: 'button', class: 'relative text-primary' },
              h(
                'span',
                { class: 'flex size-7 items-center justify-center rounded-lg bg-primary/10' },
                icon('server', 'size-4')
              ),
              h(
                'span',
                {
                  class:
                    'absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-bg-000'
                },
                o.computeTargets
              )
            )
          : null,
        h('div', { class: 'flex-1' }),
        o.context != null
          ? h(
              'button',
              {
                type: 'button',
                class:
                  'flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-000 outline-none'
              },
              icon('gauge', 'size-3.5 shrink-0'),
              h('span', { class: 'tabular-nums' }, `${o.context}%`)
            )
          : null,
        o.model
          ? h(
              'button',
              {
                type: 'button',
                'data-slot': 'button',
                'data-variant': 'ghost',
                class: cls(
                  BTN,
                  'h-8 gap-1.5 px-2.5 flex min-w-0 max-w-[220px] shrink items-center gap-1 rounded-md text-sm text-text-300'
                )
              },
              icon(o.modelIcon || 'circlePlus', 'size-4 shrink-0 text-muted-foreground'),
              h(
                'span',
                { class: 'flex min-w-0 items-center' },
                h('span', { class: 'truncate font-medium text-text-000' }, o.model),
                o.effort
                  ? h(
                      'span',
                      { class: 'ml-1.5 shrink-0 whitespace-nowrap text-text-300' },
                      `· ${o.effort}`
                    )
                  : null
              ),
              icon('chevronDown', 'size-3.5 shrink-0')
            )
          : null,
        send
      )
    )
    return h(
      'div',
      {
        'data-testid': 'conversation-composer-dock',
        'data-placement': 'bottom',
        class: 'osk-composer relative shrink-0'
      },
      h('div', {
        'aria-hidden': 'true',
        'data-testid': 'composer-surface-fade',
        class:
          'pointer-events-none absolute inset-x-0 bg-gradient-to-t from-bg-10 to-bg-10/0 -top-12 h-12'
      }),
      h(
        'div',
        { class: 'osk-dock-pad px-2 md:px-4 md:pb-[6px]' },
        h(
          'div',
          { class: 'mx-auto w-full max-w-4xl' },
          h(
            'div',
            { class: 'px-1 md:px-3' },
            statusRow,
            h(
              'div',
              { class: 'relative' },
              h('div', {
                'aria-hidden': 'true',
                'data-testid': 'composer-card-backdrop',
                class: 'relative -mb-8 rounded-2xl bg-bg-200 pb-8'
              }),
              form
            )
          )
        )
      )
    )
  }

  // ---- right panel (PreviewPanelSurface: tab strip + preview card with PreviewFileHeader) ----
  // o = { tabs: [{ title, icon?, kind?: 'file'|'notebook'|'tool' }], active, body?, custom?,
  //       content?: Element (iframe, canvas, any element: fills the content area), fill?: true,
  //       mode?: 'render'|'source' (the HTML Render/Source switch), version?: 'v1' (version navigation row),
  //       actions?: ['download','mention','more','expand','close'] }
  // Returns { el, card, header, nameEl, content, contentEl, expandButton, closeButton, modeSwitch, tabs, select(i, {title, body, content}), setContent(node), setMode(m) }.
  // el.osk is the same handle.
  function previewPanel(o) {
    // file tabs get the boxed FileTypeIcon and the extension-preserving name; tool tabs (Notebook, Files, ...) a plain icon
    const isFile = (t) =>
      t.kind ? t.kind === 'file' : !t.icon || ['file', 'fileJson'].includes(t.icon)
    const tabIcon = (t) =>
      isFile(t) ? fileTypeIcon(t.title) : icon(t.icon || 'bookOpen', 'size-3.5 shrink-0')
    const tabEls = o.tabs.map((t) => {
      const close = h(
        'button',
        {
          type: 'button',
          'data-preview-close': t.title,
          'aria-label': `Close preview of ${t.title}`,
          class: 'osk-tab-close flex size-5 shrink-0 items-center justify-center rounded-sm'
        },
        icon('x', 'size-3.5')
      )
      return h(
        'div',
        {
          role: 'presentation',
          class:
            'osk-tab group flex h-8 max-w-[160px] shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[12px]'
        },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'flex min-w-0 items-center gap-1 self-stretch rounded-md px-1 text-left',
            title: t.title
          },
          tabIcon(t),
          isFile(t) ? fileName(t.title) : h('span', { class: 'min-w-0 truncate' }, t.title)
        ),
        close
      )
    })
    const ACTION = cls(BTN, SIZE['icon-xs'], 'text-text-000')
    const act = (name, ic, label) =>
      h(
        'button',
        {
          type: 'button',
          'data-slot': 'button',
          'data-variant': 'ghost',
          'data-size': 'icon-xs',
          'data-action': name,
          'aria-label': label,
          class: ACTION
        },
        icon(ic, 'size-3')
      )
    const actions = o.actions || ['download', 'mention', 'more', 'expand', 'close']
    const A = {
      download: ['download', 'Download'],
      mention: ['atSign', 'Mention'],
      more: ['ellipsis', 'File actions'],
      expand: ['maximize2', 'Open full screen preview'],
      close: ['x', 'Close preview']
    }
    const btns = Object.fromEntries(actions.map((a) => [a, act(a, ...A[a])]))
    const nameEl = h('span', { class: 'osk-file-name min-w-0 flex-1' })
    const typeIcon = h('span', { class: 'contents' })
    const header = h(
      'header',
      {
        'data-testid': 'preview-card-header',
        class:
          'osk-file-head flex shrink-0 items-center gap-1 border-b border-border-300/50 px-2 h-8'
      },
      h(
        'span',
        { class: 'flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-text-000' },
        typeIcon,
        nameEl
      ),
      Object.values(btns)
    )
    const version = o.version
      ? h(
          'div',
          {
            'data-testid': 'artifact-preview-version-navigation',
            class:
              'osk-file-ver flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2'
          },
          button(icon('chevronLeft'), 'ghost', 'icon-xs'),
          h('span', { class: 'text-xs font-medium text-text-100' }, o.version),
          button(icon('chevronRight'), 'ghost', 'icon-xs')
        )
      : null
    // content host: .osk-file-body (kept from 0.35.1) — text bodies use the monospace look, elements fill it
    const content = h('div', { class: 'osk-file-body' })
    const modeBtns = ['render', 'source'].map((m) =>
      h(
        'button',
        { type: 'button', 'data-mode': m, class: 'h-6 rounded px-2 text-[12px] text-text-300' },
        m === 'render' ? 'Render' : 'Source'
      )
    )
    const modeSwitch = h(
      'div',
      {
        'data-research-video-export-toolbar': '',
        class:
          'osk-mode flex min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2'
      },
      h('div', { class: 'flex items-center gap-1 rounded-md bg-bg-200 p-0.5' }, modeBtns)
    )
    const viewer = h(
      'div',
      { class: 'osk-viewer flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-10' },
      modeSwitch,
      h('div', { class: 'osk-file-content relative min-h-0 flex-1' }, content)
    )
    const card = h(
      'section',
      {
        'data-testid': 'preview-card',
        role: 'tabpanel',
        class:
          'osk-card flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md bg-bg-000 shadow-card'
      },
      o.custom ? null : header,
      o.custom ? null : version,
      viewer
    )
    const el = h(
      'aside',
      {
        id: 'right-panel',
        class: cls(
          'osk-panel relative flex h-full min-w-0 w-full flex-col overflow-hidden bg-bg-10 py-[0.7px]',
          o.custom && 'osk-panel-custom'
        )
      },
      h(
        'div',
        {
          'data-testid': 'preview-panel-top-bar',
          class: 'flex min-w-0 w-full shrink-0 items-start pl-2 pr-14'
        },
        h(
          'div',
          {
            'data-testid': 'preview-tab-strip',
            class:
              'osk-tabbar scrollbar-auto-hide scroll-fade-x flex min-w-0 flex-1 basis-0 shrink-0 items-center gap-1 overflow-x-auto pb-2'
          },
          tabEls
        )
      ),
      h('div', { class: 'osk-card-wrap min-h-0 min-w-0 flex-1 pl-2 pr-1' }, card)
    )
    const handle = {
      el,
      card,
      header,
      nameEl,
      content,
      body: content,
      contentEl: null,
      expandButton: btns.expand || null,
      closeButton: btns.close || null,
      modeSwitch,
      tabs: tabEls,
      version
    }
    handle.setContent = (node) => {
      const isEl = node && node.nodeType === 1,
        text = node != null && !isEl && !(node && node.nodeType)
      content.className = cls('osk-file-body', text && 'osk-text', isEl && 'osk-element')
      if (isEl && o.fill !== false && !node.classList.contains('osk-preview-img'))
        node.classList.add('osk-fill')
      content.replaceChildren(...(node == null ? [] : [node]))
      handle.contentEl = isEl ? node : null
      return node
    }
    handle.setMode = (m) => {
      modeSwitch.style.display = m ? '' : 'none'
      modeBtns.forEach((b) => {
        const on = b.dataset.mode === m
        b.setAttribute('aria-pressed', on ? 'true' : 'false')
        b.classList.toggle('bg-bg-000', on)
        b.classList.toggle('text-text-000', on)
        b.classList.toggle('shadow-sm', on)
        b.classList.toggle('text-text-300', !on)
      })
    }
    handle.select = (i, s = {}) => {
      tabEls.forEach((tb, j) => {
        const on = j === i
        tb.classList.toggle('osk-tab-active', on)
        tb.classList.toggle('bg-bg-300', on)
        tb.classList.toggle('text-text-000', on)
        tb.classList.toggle('text-text-300', !on)
        tb.querySelector('.osk-tab-close').classList.toggle('opacity-0', !on)
      })
      const t = o.tabs[i] || {},
        title = s.title || t.title || ''
      nameEl.replaceChildren(fileName(title, 'flex-1'))
      typeIcon.replaceChildren(fileTypeIcon(title))
      if ('content' in s || 'body' in s)
        handle.setContent(s.content !== undefined ? s.content : s.body)
    }
    handle.select(o.active || 0, { content: o.content !== undefined ? o.content : o.body })
    handle.setMode(o.mode || null)
    el.osk = handle
    return handle
  }

  // ---- full workspace window ----
  // o = { compact, project, sections, title, messages, panel, composer: true|false|{...}, host, bottom,   (0.35.1 arguments)
  //       width, height, windowTitle ('Open-Science'; null hides it), radius, sessionNumber, sidebar (false = collapsed),
  //       sidebarWidth ('16%' | px), panelWidth ('40%' | px), headerActions (true), links ('link'|'unresolved') }
  function workspace(o) {
    const compact = !!o.compact
    const thread = h(
      'div',
      { class: 'osk-thread mx-auto w-full max-w-4xl gap-0 px-4 pb-[56px]' },
      o.messages.map((m) => message({ links: o.links, ...m }))
    )
    const scroller = h(
      'div',
      { class: 'osk-scroller relative min-h-0 flex-1 bg-bg-10' },
      h('div', {
        'aria-hidden': 'true',
        class:
          'osk-top-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg-10 to-bg-10/0'
      }),
      thread
    )
    const hasPanel = !compact && !!o.panel
    const GHOST8 = 'grid size-8 shrink-0 place-items-center rounded-lg text-text-300'
    const header = h(
      'header',
      {
        'data-testid': 'conversation-header',
        class: cls(
          'osk-header flex shrink-0 items-center gap-2 px-4 pb-3 pt-2',
          !hasPanel && !compact && 'md:pr-12'
        )
      },
      compact
        ? h(
            'button',
            {
              type: 'button',
              'aria-label': 'Open navigation',
              class: 'grid size-9 shrink-0 place-items-center rounded-lg text-text-300'
            },
            icon('menu', 'size-5')
          )
        : null,
      h(
        'h1',
        { class: 'min-w-0 flex-1 text-[13px] font-semibold text-text-000' },
        h(
          'button',
          {
            type: 'button',
            'data-slot': 'button',
            'data-variant': 'ghost',
            class: cls(
              BTN,
              'h-auto min-h-8 min-w-0 max-w-[min(100%,20rem)] shrink justify-start gap-2 px-2 py-1 text-[13px] font-semibold text-text-000 transition-none',
              compact && 'osk-title-compact'
            )
          },
          o.sessionNumber != null
            ? h(
                'span',
                { class: 'shrink-0 font-normal text-muted-foreground' },
                `#${o.sessionNumber}`
              )
            : null,
          h('span', { class: 'truncate', title: o.title }, o.title),
          icon('chevronDown', 'size-3.5 text-muted-foreground')
        )
      ),
      o.headerActions !== false && !compact
        ? h(
            'button',
            { type: 'button', 'aria-label': 'Export diagnostics…', class: GHOST8 },
            icon('stethoscope', 'size-4', 1.75)
          )
        : null,
      o.headerActions !== false
        ? h(
            'button',
            { type: 'button', 'aria-haspopup': 'menu', class: GHOST8 },
            icon('ellipsis', 'size-4', 1.75)
          )
        : null
    )
    const comp =
      o.bottom ||
      (o.composer === false
        ? null
        : composer(
            typeof o.composer === 'object'
              ? { compact, host: o.host, ...o.composer }
              : { compact, host: o.host }
          ))
    const conv = h(
      'div',
      {
        'data-testid': 'workspace-file-drop-zone',
        class:
          'osk-conv relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-10 p-[6px] pl-4'
      },
      header,
      scroller,
      comp
    )
    const showSide = !compact && o.sidebar !== false
    const side = showSide ? sidebar(o) : null
    const panel = hasPanel ? previewPanel(o.panel) : null
    const W = (v, d) => (v == null ? d : typeof v === 'number' ? `${v}px` : v)
    const group = h(
      'div',
      {
        class: 'osk-group flex min-w-0 flex-1 -mr-[10px]',
        style: { '--osk-side-w': W(o.sidebarWidth, '16%'), '--osk-panel-w': W(o.panelWidth, '40%') }
      },
      side ? h('div', { id: 'left-panel', class: 'osk-side-panel' }, side) : null,
      side
        ? h('div', {
            'data-slot': 'resizable-handle',
            class: 'osk-handle relative flex w-px items-center justify-center bg-transparent'
          })
        : null,
      h('div', { id: 'main-content', class: 'osk-conv-panel' }, conv),
      panel
        ? h('div', {
            'data-slot': 'resizable-handle',
            class:
              'osk-handle osk-handle-line relative flex w-px items-center justify-center bg-border'
          })
        : null,
      panel ? h('div', { id: 'right-panel-resizable', class: 'osk-preview-panel' }, panel.el) : null
    )
    const previewToggle = panel
      ? h(
          'button',
          {
            type: 'button',
            'data-testid': 'workspace-preview-toggle',
            'aria-expanded': 'true',
            class:
              'osk-preview-toggle absolute right-2 top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-primary/20 shadow-card backdrop-blur text-action-panel-toggle'
          },
          icon('panelRight', 'size-4')
        )
      : null
    const sideToggle =
      !compact && !showSide
        ? h(
            'button',
            {
              type: 'button',
              'data-testid': 'workspace-sidebar-toggle',
              'aria-expanded': 'false',
              class:
                'absolute left-0 top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-action-panel-toggle shadow-none'
            },
            icon('panelLeft', 'size-4')
          )
        : null
    const layout = h(
      'div',
      { class: 'osk-layout relative flex h-full min-w-0' },
      group,
      previewToggle,
      sideToggle
    )
    const main = h(
      'main',
      { class: 'osk-main bg-bg-10 text-[13px] leading-normal text-text-000 md:p-[10px]' },
      layout
    )
    const title = o.windowTitle === undefined ? 'Open-Science' : o.windowTitle
    const win = h(
      'div',
      {
        class: cls('osk-window', compact ? 'osk-compact' : 'osk-wide', o.radius && 'osk-rounded'),
        style: {
          width: o.width ? `${o.width}px` : null,
          height: o.height ? `${o.height}px` : null,
          borderRadius: typeof o.radius === 'number' ? `${o.radius}px` : null
        }
      },
      h(
        'div',
        { class: 'osk-titlebar' },
        h('span', { class: 'osk-lights' }, h('i'), h('i'), h('i')),
        title ? h('span', { class: 'osk-wintitle' }, title) : null
      ),
      main
    )
    return {
      el: win,
      main,
      thread,
      scroller,
      conv,
      header,
      side,
      composer: comp,
      panelEl: panel ? panel.el : null,
      panel,
      previewToggle,
      msg: (i) => thread.querySelector(`.osk-msg[data-i="${i}"]`)
    }
  }

  // wrap first occurrence of text inside node in <mark class="osk-hl">
  function mark(root, text) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode());) {
      const k = n.data.indexOf(text)
      if (k < 0) continue
      const a = n.splitText(k)
      a.splitText(text.length)
      const m = document.createElement('mark')
      m.className = 'osk-hl'
      a.replaceWith(m)
      m.append(a)
      return m
    }
    console.warn('osk mark not found:', text)
    return null
  }

  // ---- project actions menu (WorkspaceSidebarView project dropdown) ----
  function projectMenu() {
    const ITEM =
      'relative flex min-h-8 cursor-pointer items-center rounded-lg px-2 py-1.5 text-sm outline-none select-none gap-2'
    const item = (ic, label) =>
      h(
        'div',
        { role: 'menuitem', class: ITEM },
        h(
          'span',
          { class: 'flex size-4 shrink-0 items-center justify-center' },
          icon(ic, 'size-4')
        ),
        label
      )
    const imp = item('packageOpen', 'Import Session package…')
    const el = h(
      'div',
      {
        role: 'menu',
        class:
          'z-50 min-w-[8rem] overflow-hidden overscroll-contain rounded-[15px] border border-border bg-popover p-1.5 text-popover-foreground shadow-menu outline-none w-72 osk-menu'
      },
      item('settings', 'Project settings'),
      item('download', 'Download artifacts…'),
      imp
    )
    return { el, importItem: imp }
  }

  // ---- Import Session package dialog (PackageOperationDialog, index chunk) ----
  // state: { phase: 'validating'|'importing'|'completed', percent, filename }
  function packageDialog(filename) {
    const statusIcon = h('div', {
      class: 'mt-0.5 flex size-6 shrink-0 items-center justify-center text-primary'
    })
    const status = h('p', { role: 'status', class: 'text-base font-semibold leading-6' })
    const meter = h('div', { class: 'osk-meter' })
    const desc = h(
      'p',
      { class: 'sr-only' },
      'Import creates a new read-only Session. No code runs automatically.'
    )
    const footer = h('div', {
      'data-package-footer': '',
      class:
        'flex shrink-0 flex-wrap justify-end gap-3 [&_button]:h-auto [&_button]:min-h-8 [&_button]:max-w-full [&_button]:whitespace-normal border-t border-border-300/90 px-5 py-3.5'
    })
    const panel = h(
      'div',
      {
        role: 'dialog',
        'aria-label': 'Import Session package',
        class:
          'osk-dialog flex flex-col overflow-y-auto rounded-xl border border-border bg-card p-0 text-foreground shadow-dialog outline-none'
      },
      h(
        'div',
        {
          class:
            'flex shrink-0 items-center justify-between gap-3 border-b border-border-300/90 px-5 py-3.5 flex-col items-stretch gap-3'
        },
        h(
          'div',
          { class: 'min-w-0 w-full space-y-1' },
          h(
            'div',
            { class: 'flex items-start gap-2' },
            h(
              'h2',
              {
                class:
                  'min-w-0 text-lg font-semibold text-text-000 [overflow-wrap:anywhere] min-w-0 flex-1 py-0.5 leading-6'
              },
              'Import Session package'
            ),
            h(
              'div',
              { class: 'flex shrink-0 items-center gap-1' },
              button(
                icon('x', 'size-4'),
                'ghost',
                'icon-sm',
                'cursor-pointer rounded-lg text-muted-foreground'
              )
            )
          ),
          h('p', { class: 'truncate text-sm text-muted-foreground' }, filename),
          desc
        )
      ),
      h(
        'div',
        { class: 'min-w-0 p-5 [overflow-wrap:anywhere] min-h-0' },
        h(
          'div',
          { class: 'space-y-4' },
          h(
            'div',
            { class: 'space-y-4' },
            h(
              'div',
              { class: 'flex items-start gap-3' },
              statusIcon,
              h('div', { class: 'min-w-0 flex-1 space-y-1.5' }, status)
            ),
            meter
          )
        )
      ),
      footer
    )
    const overlay = h('div', { class: 'osk-overlay bg-black/50' })
    const el = h('div', { class: 'osk-dialog-layer' }, overlay, panel)
    let last = ''
    function set(st) {
      const key = `${st.phase}|${st.percent}`
      if (key === last) return
      last = key
      const done = st.phase === 'completed'
      statusIcon.replaceChildren(
        icon(done ? 'check' : 'loaderCircle', `size-5 ${done ? '' : 'osk-spin'}`)
      )
      status.textContent = done
        ? 'Session imported'
        : st.phase === 'validating'
          ? 'Validating package…'
          : 'Importing research…'
      if (st.phase === 'validating')
        meter.replaceChildren(
          h(
            'div',
            { class: 'space-y-2 text-xs text-muted-foreground' },
            h(
              'div',
              { role: 'progressbar', class: 'h-2 w-full overflow-hidden rounded-full bg-muted' },
              h('div', { class: 'osk-indet h-full w-1/3 rounded-full bg-primary' })
            )
          )
        )
      else if (st.phase === 'importing' || done) {
        const p = done ? 100 : Math.floor(st.percent)
        meter.replaceChildren(
          h(
            'div',
            { class: 'space-y-2' },
            h(
              'div',
              { class: 'flex items-baseline justify-between gap-3' },
              h(
                'span',
                { class: 'text-xs text-muted-foreground' },
                done ? 'Session imported' : 'Importing files…'
              ),
              h('span', { class: 'text-sm font-semibold tabular-nums' }, `${p}%`)
            ),
            h(
              'div',
              {
                role: 'progressbar',
                class: 'osk-progress h-2 w-full overflow-hidden rounded-full bg-muted'
              },
              h('div', { class: 'h-full rounded-full bg-primary', style: { width: `${p}%` } })
            )
          )
        )
      } else meter.replaceChildren()
      footer.replaceChildren(
        ...(done
          ? [
              button('Close', 'outline'),
              button('Open imported Session', 'default', 'default', 'osk-open-btn')
            ]
          : [button('Cancel', 'ghost'), button('Run in background', 'default')])
      )
    }
    set({ phase: 'validating' })
    return { el, panel, overlay, set, openButton: () => footer.querySelector('.osk-open-btn') }
  }

  // ---- Replay panel for an imported Session (SessionReplayPreview) — unchanged from the 0.35.1 kit (not re-matched to 1.2.1) ----
  function replayPanel(o) {
    const transcript = h(
      'section',
      {
        'aria-label': 'Historical conversation',
        class:
          'osk-replay-transcript relative min-h-0 min-w-0 overflow-hidden border-border-200 bg-bg-000 px-4 py-3'
      },
      h(
        'div',
        { class: 'osk-replay-inner' },
        h(
          'details',
          { open: '', class: 'text-xs text-text-300 osk-source' },
          h(
            'summary',
            { class: 'cursor-pointer font-medium text-text-100' },
            'Imported research history'
          ),
          h('p', { class: 'mt-2' }, `Imported on ${o.importedOn}`),
          h('p', { class: 'mt-2 leading-5' }, `Source: ${o.sourceFile} · ${o.counts}`)
        ),
        o.steps.map((s) =>
          h(
            'div',
            { class: 'osk-replay-step' },
            h('div', { class: 'mb-1 text-xs font-medium text-text-300' }, s.who),
            s.who === 'User'
              ? h(
                  'div',
                  { class: 'flex min-w-0 flex-col items-end' },
                  h(
                    'div',
                    {
                      'data-slot': 'user-message-bubble',
                      class:
                        'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text'
                    },
                    h('div', { class: 'whitespace-pre-wrap break-words' }, s.text)
                  )
                )
              : h('div', { class: 'text-sm leading-relaxed text-text-000' }, markdown(s.text)),
            s.meta
              ? h(
                  'div',
                  {
                    class:
                      'mt-1 flex min-h-6 w-full items-center justify-end text-[11px] leading-4 text-text-000/70 tabular-nums'
                  },
                  s.meta
                )
              : null
          )
        )
      )
    )
    const fill = h('div', { class: 'absolute h-full bg-primary' })
    const thumb = h('span', {
      class: 'osk-thumb relative z-10 block size-3 rounded-full bg-primary'
    })
    const time = h('span', {
      class: 'osk-replay-time font-mono text-xs tabular-nums text-muted-foreground'
    })
    const stepLabel = h('span', { class: 'min-w-0 truncate' })
    const stepCount = h('span', { class: 'ml-auto shrink-0 tabular-nums text-muted-foreground' })
    const playBtn = button(icon('play', 'size-3.5'), 'ghost', 'icon-sm', 'osk-play text-text-000')
    const controls = h(
      'div',
      {
        class: 'shrink-0 space-y-1 border-t border-border-200 bg-bg-000 px-3 py-2',
        'data-testid': 'replay-controls'
      },
      h(
        'div',
        { class: 'flex min-w-0 items-center gap-1', 'data-testid': 'replay-step-actions' },
        playBtn,
        h(
          'button',
          {
            type: 'button',
            class: `${BTN} h-8 min-w-0 max-w-xl flex-1 justify-start gap-2 px-1 text-xs`
          },
          icon('messageSquare', 'size-3.5'),
          stepLabel,
          stepCount,
          icon('chevronDown', 'size-3')
        ),
        time
      ),
      h(
        'div',
        {
          class: 'group/timeline relative flex h-6 items-center',
          'data-testid': 'replay-timeline'
        },
        h(
          'div',
          { class: 'relative flex h-6 w-full touch-none select-none items-center' },
          h(
            'div',
            { class: 'relative h-1 w-full grow overflow-hidden rounded-full bg-muted osk-track' },
            fill,
            ...o.breaks.map((b) =>
              h('span', {
                class: 'pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-bg-000',
                style: { left: `${b}%` }
              })
            )
          ),
          thumb
        )
      )
    )
    const el = h(
      'div',
      {
        class: 'osk-replay flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg-000 text-text-100',
        'data-testid': 'replay-panel'
      },
      h(
        'div',
        { class: 'osk-replay-head flex items-center gap-2 border-b border-border-200' },
        h(
          'span',
          { class: 'min-w-0 flex-1 truncate text-[13px] font-semibold text-text-000' },
          o.title
        ),
        h(
          'span',
          { class: 'rounded-full border border-border-200 px-3 py-1 text-xs text-text-300' },
          'Read-only research history'
        )
      ),
      transcript,
      controls
    )
    function set(p, stepIndex, label, total, clock) {
      fill.style.width = `${p * 100}%`
      thumb.style.left = `calc(${p * 100}% - 6px)`
      stepLabel.textContent = label
      stepCount.textContent = `${stepIndex + 1} / ${total}`
      time.textContent = clock
    }
    return { el, transcript, inner: transcript.firstChild, set }
  }

  window.OSKit = {
    version: '1.2.1',
    h,
    icon,
    markdown,
    workspace,
    message,
    toolGroup,
    mark,
    packageDialog,
    replayPanel,
    button,
    projectMenu,
    sidebar,
    generated,
    generatedCard,
    composer,
    previewPanel,
    turnFooter,
    fileName,
    fileTypeIcon
  }
})()
