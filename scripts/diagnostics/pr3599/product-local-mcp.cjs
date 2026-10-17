const fs = require('node:fs')
const readline = require('node:readline')
const marker = process.argv[2]
const record = (event) => fs.appendFileSync(marker, JSON.stringify({event, pid:process.pid, ppid:process.ppid, at:new Date().toISOString(), credentialMatched:process.env.PR3599_TEST_SECRET === 'synthetic-pr3599-no-access'})+'\n')
record('started')
process.on('exit', () => record('exit'))
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const result = request.method === 'initialize' ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'pr3599-local-lifecycle',version:'1'}} : request.method === 'tools/list' ? {tools:[{name:'lifecycle_probe',description:'Isolated lifecycle probe',inputSchema:{type:'object',properties:{}}}]} : {}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n')
}).on('close', () => {record('stdin-closed'); process.exit(0)})
