import { parentPort, workerData } from 'node:worker_threads'
import { bundleSessionApp } from './session-app-bundle.js'

// Transform module syntax off the desktop backend's event loop. Never evaluate the app here.
parentPort!.postMessage(bundleSessionApp(workerData.bytes, workerData.name) ?? null)
