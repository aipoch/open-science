/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Compile-time only: runtime environment variables cannot switch a production bundle's cipher.
import { resolve } from 'node:path'
export const credentialSandboxEnabled = (env = process.env) =>
  env.OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION === '1' &&
  env.OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CREDENTIALS === 'sandbox'
export const credentialSandboxModule = (root) =>
  resolve(root, 'src/main/local-update-validation/credential-sandbox.ts')
export const credentialSandboxImports =
  /^(?:\.{1,2}\/)+credential-identity\/(?:bootstrap|node-cipher)$/
