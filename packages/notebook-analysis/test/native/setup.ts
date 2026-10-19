const command = 'npm run test:native'
if (process.env.RUN_KERNEL !== '1') {
  throw new Error(`${command} requires RUN_KERNEL=1`)
}
for (const name of [
  'OPEN_SCIENCE_TEST_PYTHON',
  'OPEN_SCIENCE_TEST_R_COMMAND',
  'OPEN_SCIENCE_TEST_R_ENV'
]) {
  if (!process.env[name]?.trim()) throw new Error(`${command} requires ${name}`)
}
