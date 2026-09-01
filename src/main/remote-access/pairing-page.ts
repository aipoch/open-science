import { randomBytes } from 'node:crypto'

import openScienceLogoSvg from './openscience-logo.svg?raw'

export const REMOTE_PAIR_STATUS_PATH = '/__open_science_remote/pair/status'

const openScienceLogo = openScienceLogoSvg.replace(
  '<svg ',
  '<svg class="brand-logo" aria-hidden="true" focusable="false" '
)

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

export const renderPairingPage = (params: {
  code: string
  browser: string
  platform: string
  expiresAt: number
}): { html: string; nonce: string } => {
  const nonce = randomBytes(18).toString('base64')
  const code = escapeHtml(params.code)
  const browser = escapeHtml(params.browser)
  const platform = escapeHtml(params.platform)

  return {
    nonce,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>Connect to Open Science</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 24px; background: #f5f6f4; color: #1d211f; }
      .card { width: min(100%, 440px); padding: 30px; border: 1px solid #d9ddda; border-radius: 20px; background: #fff; box-shadow: 0 24px 70px rgba(22, 31, 27, .12); }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-logo { width: 42px; height: 41px; flex: none; color: #2a2a28; }
      .brand-name { font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif; font-size: 26px; font-weight: 500; line-height: 1; letter-spacing: -.02em; }
      h1 { margin: 22px 0 8px; font-size: 24px; line-height: 1.25; }
      p { margin: 0; color: #66716c; font-size: 14px; line-height: 1.6; }
      .code { margin: 24px 0 12px; padding: 18px; border: 1px solid #cfd6d2; border-radius: 14px; background: #f7faf8; text-align: center; font: 700 30px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; color: #075f50; }
      .device { margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e8e6; font-size: 12px; color: #7b847f; }
      .status { display: flex; align-items: center; gap: 8px; margin-top: 20px; font-size: 13px; color: #53605a; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #d69e2e; box-shadow: 0 0 0 5px rgba(214, 158, 46, .13); }
      .status.approved .dot { background: #0d9a75; box-shadow: 0 0 0 5px rgba(13, 154, 117, .13); }
      .status.rejected .dot { background: #d14545; box-shadow: 0 0 0 5px rgba(209, 69, 69, .13); }
      @media (prefers-color-scheme: dark) {
        body { background: #101412; color: #edf2ef; }
        .card { background: #171c19; border-color: #303834; box-shadow: 0 24px 70px rgba(0, 0, 0, .35); }
        p, .status { color: #aab5af; }
        .brand-logo { color: #edf2ef; }
        .code { background: #111714; border-color: #36423c; color: #66d7b7; }
        .device { border-color: #303834; color: #89958f; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand">
        ${openScienceLogo}
        <div class="brand-name">Open Science</div>
      </div>
      <h1>Approve this browser</h1>
      <p>On your home computer, open Open Science → Settings → Remote, then verify and approve the pairing code below.</p>
      <div class="code" aria-label="Pairing code">${code}</div>
      <p>Choose “Allow for up to 12 hours” or “Trust this browser for 180 days”. Do not share this pairing code with anyone.</p>
      <div class="device">${browser} · ${platform}</div>
      <div id="status" class="status"><span class="dot"></span><span>Waiting for approval…</span></div>
    </main>
    <script nonce="${nonce}">
      const statusNode = document.getElementById('status');
      const expiry = ${params.expiresAt};
      let stopped = false;
      const setStatus = (kind, message) => {
        statusNode.className = 'status ' + kind;
        statusNode.querySelector('span:last-child').textContent = message;
      };
      const poll = async () => {
        if (stopped) return;
        if (Date.now() >= expiry) {
          setStatus('rejected', 'This pairing code has expired. Refresh the page to try again.');
          return;
        }
        try {
          const response = await fetch('${REMOTE_PAIR_STATUS_PATH}', { cache: 'no-store', credentials: 'same-origin' });
          const result = await response.json();
          if (result.status === 'approved') {
            stopped = true;
            setStatus('approved', 'Approved. Opening Open Science…');
            window.setTimeout(() => window.location.replace('/'), 300);
            return;
          }
          if (result.status === 'rejected') {
            stopped = true;
            setStatus('rejected', 'This request was rejected.');
            return;
          }
          if (result.status === 'expired') {
            stopped = true;
            setStatus('rejected', 'This pairing code has expired. Refresh the page to try again.');
            return;
          }
        } catch { /* retry while the home computer reconnects */ }
        window.setTimeout(poll, 2000);
      };
      poll();
    </script>
  </body>
</html>`
  }
}
