'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Node-only inherited E2E preload. */
// Electron may load NODE_OPTIONS before its app API is initialized. Do not load or cache
// its explicit bootstrap fixture here; ordinary Node children still need the full setup.
if (!process.versions.electron) require('./node-runtime-preload.cjs')
