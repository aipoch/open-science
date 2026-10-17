import suite from './suite.json'

// Dedicated execution must fail on missing activation/prerequisites, never pass with skips.
for (const [name, value] of Object.entries(suite.activation)) {
  if (process.env[name] !== value) throw new Error(`${suite.command} requires ${name}=${value}`)
}
for (const name of suite.requiredEnvironment) {
  if (!process.env[name]?.trim()) throw new Error(`${suite.command} requires ${name}`)
}
