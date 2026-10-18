// Route only the update host inside a disposable account. No TLS/signature bypass,
// product patch, startup argument injection, or machine-wide proxy/certificate change.
import { createServer, request } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function startIsolatedUpdateSource({ runProcess, evidence, directory, getSource }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Update source routing is restricted to disposable GitHub runners')
  const pfx = join(directory, 'temporary-update-source.pfx')
  const password = randomUUID()
  const host = 'statics.aipoch.com'
  const settings = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const proxyApi = await readFile(new URL('./user-update-proxy.ps1', import.meta.url), 'utf8')
  const execute = async (script, env = {}) => runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', proxyApi + '\n' + script], { env: { ...process.env, ...env }, timeoutMs: 60000 })
  const setup = await execute(`
$ErrorActionPreference='Stop'
function Phase($name) { Add-Content -LiteralPath $env:UPDATE_SOURCE_PHASE_LOG -Value ((Get-Date -Format o)+' '+$name) }
Phase 'ordinary-account-check'
if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Proxy fixture must belong to the ordinary account' }
$policy=Get-ItemProperty 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
if($policy -and $policy.PSObject.Properties['ProxySettingsPerUser'] -and $policy.ProxySettingsPerUser -eq 0) { throw 'Machine-wide proxy policy is outside the test scope' }
$key=$env:UPDATE_SOURCE_REGISTRY
$prior=@{}
$properties=Get-ItemProperty -LiteralPath $key
foreach($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
  $property=$properties.PSObject.Properties[$name]
  $prior[$name]=@{exists=($null -ne $property);value=if($property) {$property.Value} else {$null}}
}
Phase 'create-certificate'
$cert=New-SelfSignedCertificate -DnsName 'statics.aipoch.com' -CertStoreLocation Cert:\\CurrentUser\\My -Type SSLServerAuthentication -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
Phase ('certificate-created '+$cert.Thumbprint)
Phase 'export-pfx'
[IO.File]::WriteAllBytes($env:UPDATE_SOURCE_PFX,$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$env:UPDATE_SOURCE_PASSWORD))
[IO.File]::WriteAllBytes($env:UPDATE_SOURCE_PFX+'.cer',$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
Phase 'certificate-ready'
@{thumbprint=$cert.Thumbprint;prior=$prior;wininet=[UpdateSourceProxy]::Read();sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Depth 5 -Compress
`, { UPDATE_SOURCE_REGISTRY: settings, UPDATE_SOURCE_PFX: pfx, UPDATE_SOURCE_PASSWORD: password, UPDATE_SOURCE_PHASE_LOG: join(directory, 'update-source-setup.log') })
  const state = JSON.parse(setup.stdout)
  const events = []
  const sockets = new Set()
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
  let proxy, tls
  const restore = async () => {
    await executeTrustCommand('-delstore')
    const result = await execute(`
$ErrorActionPreference='Stop'
$state=$env:UPDATE_SOURCE_STATE | ConvertFrom-Json
$key=$env:UPDATE_SOURCE_REGISTRY
[UpdateSourceProxy]::Write($state.wininet.Flags,$state.wininet.Proxy,$state.wininet.Bypass,$state.wininet.AutoConfig)
foreach($property in $state.prior.PSObject.Properties) {
  if($property.Value.exists) { Set-ItemProperty -LiteralPath $key -Name $property.Name -Value $property.Value.value }
  elseif((Get-ItemProperty -LiteralPath $key).PSObject.Properties[$property.Name]) { Remove-ItemProperty -LiteralPath $key -Name $property.Name }
}
foreach($store in @('Root','My')) {
  $path='Cert:\\CurrentUser\\'+$store+'\\'+$state.thumbprint
  if($store -eq 'My' -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path }
  if(Test-Path -LiteralPath $path) { throw 'Temporary update source certificate remains' }
}
$actual=[UpdateSourceProxy]::Read()
foreach($name in @('Flags','Proxy','Bypass','AutoConfig')) { if([string]$actual.$name -ne [string]$state.wininet.$name) { throw ('Proxy restoration mismatch: '+$name) } }
@{restored=$true;thumbprint=$state.thumbprint;wininet=$actual;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress
`, { UPDATE_SOURCE_REGISTRY: settings, UPDATE_SOURCE_STATE: JSON.stringify(state) })
    await evidence('isolated-update-source-restored', { ...JSON.parse(result.stdout), exitCode: result.code, events })
  }
  const executeTrustCommand = async operation => execute(`
$ErrorActionPreference='Stop'
Add-Content -LiteralPath $env:UPDATE_SOURCE_PHASE_LOG -Value ((Get-Date -Format o)+' certutil-current-user-root '+$env:UPDATE_SOURCE_OPERATION)
if($env:UPDATE_SOURCE_OPERATION -eq '-delstore' -and -not (Test-Path -LiteralPath ('Cert:\\CurrentUser\\Root\\'+$env:UPDATE_SOURCE_THUMBPRINT))) { exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class CertificateConsentWindow {
  public delegate bool Visitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visit, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Visitor visit, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static string Text(IntPtr window) { var text=new StringBuilder(16384); GetWindowText(window,text,text.Capacity); return text.ToString(); }
  public static IntPtr[] Windows(int pid) { var windows=new List<IntPtr>(); EnumWindows((window,data)=>{uint owner; GetWindowThreadProcessId(window,out owner); if(owner==pid) windows.Add(window); return true;},IntPtr.Zero); return windows.ToArray(); }
  public static string[] Children(IntPtr parent) {var texts=new List<string>(); EnumChildWindows(parent,(window,data)=>{texts.Add(Text(window));return true;},IntPtr.Zero);return texts.ToArray();}
}
'@
$target=if($env:UPDATE_SOURCE_OPERATION -eq '-addstore') { '"'+$env:UPDATE_SOURCE_PFX+'.cer"' } else { $env:UPDATE_SOURCE_THUMBPRINT }
$child=Start-Process certutil.exe -ArgumentList @('-user','-f',$env:UPDATE_SOURCE_OPERATION,'Root',$target) -WindowStyle Hidden -PassThru -RedirectStandardOutput ($env:UPDATE_SOURCE_PHASE_LOG+'.certutil'+$env:UPDATE_SOURCE_OPERATION) -RedirectStandardError ($env:UPDATE_SOURCE_PHASE_LOG+'.certutil-error'+$env:UPDATE_SOURCE_OPERATION)
$null=$child.Handle
$deadline=(Get-Date).AddSeconds(30)
$confirmed=$false
while(-not $child.HasExited -and (Get-Date) -lt $deadline) {
  $windows=[CertificateConsentWindow]::Windows($child.Id)
  foreach($window in $windows) {
    $names=[CertificateConsentWindow]::Children($window)
    $normalized=($names -join '').Replace(' ','').Replace([string][char]0x200e,'').ToUpperInvariant()
    if(-not $confirmed -and $normalized.Contains($env:UPDATE_SOURCE_THUMBPRINT)) {
      @{pid=$child.Id;created=$child.StartTime.ToUniversalTime().ToString('o');title=[CertificateConsentWindow]::Text($window);text=$names;expectedThumbprint=$env:UPDATE_SOURCE_THUMBPRINT} | ConvertTo-Json -Depth 5 | Set-Content ($env:UPDATE_SOURCE_PHASE_LOG+'.consent'+$env:UPDATE_SOURCE_OPERATION+'.json')
      $handle=[CertificateConsentWindow]::GetDlgItem($window,6)
      if($handle -eq [IntPtr]::Zero -or [CertificateConsentWindow]::Text($handle).Replace('&','') -ne 'Yes') { throw 'Certificate confirmation has no native Yes button' }
      Add-Content -LiteralPath $env:UPDATE_SOURCE_PHASE_LOG -Value ((Get-Date -Format o)+' confirm-matching-certificate-button')
      if(-not [CertificateConsentWindow]::PostMessage($handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Certificate confirmation button rejected BM_CLICK' }
      $confirmed=$true
    }
  }
  [void]$child.WaitForExit(100)
}
if(-not $child.HasExited) { throw 'Certificate confirmation did not finish; preserve the exact consent-window evidence' }
if($child.ExitCode -ne 0) { throw ('Current-user certificate import failed: '+$child.ExitCode) }
@{pid=$child.Id;exitCode=$child.ExitCode;confirmedExactThumbprint=$confirmed;forced=$false} | ConvertTo-Json | Set-Content ($env:UPDATE_SOURCE_PHASE_LOG+'.consent-result'+$env:UPDATE_SOURCE_OPERATION+'.json')
Add-Content -LiteralPath $env:UPDATE_SOURCE_PHASE_LOG -Value ((Get-Date -Format o)+' root-operation-complete '+$env:UPDATE_SOURCE_OPERATION)
`, { UPDATE_SOURCE_PFX: pfx, UPDATE_SOURCE_PHASE_LOG: join(directory, 'update-source-setup.log'), UPDATE_SOURCE_THUMBPRINT: state.thumbprint, UPDATE_SOURCE_OPERATION: operation })
  try {
    await executeTrustCommand('-addstore')
    tls = createHttpsServer({ pfx: await readFile(pfx), passphrase: password }, (incoming, outgoing) => {
      const source = getSource()
      const path = new URL(incoming.url, 'https://' + host).pathname.replace(/^\/open-science\/app\/stable/, '')
      events.push({ at: new Date().toISOString(), method: incoming.method, host: incoming.headers.host, path, range: incoming.headers.range })
      if (!source || incoming.headers.host?.split(':')[0] !== host) { outgoing.writeHead(503).end(); return }
      const upstream = request(new URL(path, source), { method: incoming.method, headers: { ...incoming.headers, host: new URL(source).host } }, response => {
        outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing)
      })
      upstream.on('error', error => { events.push({ error: error.message, path }); if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
      outgoing.on('close', () => upstream.destroy())
      incoming.pipe(upstream)
    })
    tls.on('connection', track)
    tls.on('tlsClientError', error => events.push({ tlsError: error.message }))
    await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve))
    proxy = createServer((_req, res) => res.writeHead(403).end())
    proxy.on('connection', track)
    proxy.on('connect', (req, client, head) => {
      // Other HTTPS traffic is tunneled unchanged; only this exact host terminates TLS locally.
      const target = new URL('https://' + req.url)
      const intercepted = target.hostname === host && target.port === ''
      const remote = connect(intercepted ? tls.address().port : Number(target.port || 443), intercepted ? '127.0.0.1' : target.hostname, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) remote.write(head)
        remote.pipe(client); client.pipe(remote)
      })
      track(remote)
      remote.on('error', () => client.destroy())
      client.on('error', () => remote.destroy())
      client.on('close', () => remote.destroy())
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const address = '127.0.0.1:' + proxy.address().port
    const configured = await execute(`
$ErrorActionPreference='Stop'
[UpdateSourceProxy]::Write(3,('https='+$env:UPDATE_SOURCE_PROXY),'localhost;127.0.0.1;<local>',$null)
[UpdateSourceProxy]::Read() | ConvertTo-Json -Compress
`, { UPDATE_SOURCE_REGISTRY: settings, UPDATE_SOURCE_PROXY: address })
    await evidence('isolated-update-source', { host, address, wininet: JSON.parse(configured.stdout), thumbprint: state.thumbprint, sid: state.sid, scope: 'disposable ordinary account HKCU proxy and CurrentUser certificate stores', productArgsChanged: false, signatureVerificationBypassed: false })
    return { close: async () => {
      await evidence('isolated-update-source-requests', events)
      for (const socket of sockets) socket.destroy()
      await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => tls.close(resolve))])
      await restore()
    } }
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    proxy?.close(); tls?.close()
    await restore()
    throw error
  } finally { await rm(pfx, { force: true }); await rm(pfx + '.cer', { force: true }) }
}
