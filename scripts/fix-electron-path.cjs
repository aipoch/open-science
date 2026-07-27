#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Normalize node_modules/electron/path.txt so the electron binary resolves without a trailing
// newline. Different npmmirror CDNs / extraction paths have shipped this 32-byte file with an
// appended LF; electron's own index.js reads it via fs.readFileSync(pathFile, 'utf-8') without
// trimming, so the embedded '\n' leaks into child_process.spawn and produces ENOENT. We rewrite
// the file here at install time so every dev environment and CI runner is immune, regardless of
// what the mirror served.

const fs = require('node:fs')
const path = require('node:path')

const pathFile = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt')

if (!fs.existsSync(pathFile)) {
  // electron isn't installed yet (e.g. a web-only install before electron-builder runs); nothing
  // to normalize. Exit 0 so postinstall chains that depend on this step stay green.
  process.exit(0)
}

const raw = fs.readFileSync(pathFile, 'utf-8')
// Strip every trailing CR/LF/space; preserve the leading "Electron.app/..." exactly. Only rewrite
// the file when the bytes actually change, so repeated installs don't churn git status (or, in
// stored-as-patch setups, prevent pointless patch noise).
const normalized = raw.replace(/[\r\n]+$/, '')

if (normalized === raw) {
  process.exit(0)
}

fs.writeFileSync(pathFile, normalized, 'utf-8')

// eslint-disable-next-line no-console
console.log('fix-electron-path: stripped trailing newline from node_modules/electron/path.txt')
