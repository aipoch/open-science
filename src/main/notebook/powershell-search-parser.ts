import { execFile } from 'node:child_process'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'

// Only parse stdin. Never evaluate AST values or invoke user script blocks.
const parserScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
function Read-Literal($node) {
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return ,@($node.Value) }
  if ($node -is [System.Management.Automation.Language.ConstantExpressionAst]) { return ,@([string]$node.Value) }
  if ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and $node.NestedExpressions.Count -eq 0) { return ,@($node.Value) }
  if ($node -is [System.Management.Automation.Language.CommandParameterAst]) {
    $values = @('-' + $node.ParameterName)
    if ($null -ne $node.Argument) { $values += Read-Literal $node.Argument }
    return ,$values
  }
  if ($node -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $values = @()
    foreach ($element in $node.Elements) { $values += Read-Literal $element }
    return ,$values
  }
  return ,@($null)
}
try {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw 'Shell search scope denied: PowerShell syntax could not be parsed.' }
  $commands = @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst]}, $true) | ForEach-Object {
    $arguments = @()
    foreach ($element in $_.CommandElements | Select-Object -Skip 1) { $arguments += Read-Literal $element }
    @{ name = $_.GetCommandName(); arguments = $arguments }
  })
  [Console]::Out.Write((ConvertTo-Json -InputObject $commands -Depth 10 -Compress))
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}
`

export type ParsedPowerShellCommand = { name: string | null; arguments: (string | null)[] }

export const parsePowerShellSearchCommands = (
  source: string,
  signal?: AbortSignal
): Promise<ParsedPowerShellCommand[]> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      resolveWindowsPowerShellExecutable(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(parserScript, 'utf16le').toString('base64')
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024, signal, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Shell search scope denied: PowerShell syntax inspection failed.', {
              cause: error
            })
          )
          return
        }
        try {
          const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''))
          if (
            !Array.isArray(value) ||
            value.some(
              (entry) =>
                !entry ||
                (entry.name !== null && typeof entry.name !== 'string') ||
                !Array.isArray(entry.arguments) ||
                entry.arguments.some((arg: unknown) => arg !== null && typeof arg !== 'string')
            )
          )
            throw new Error('Invalid PowerShell parser output')
          resolve(value)
        } catch (cause) {
          reject(
            new Error('Shell search scope denied: invalid PowerShell syntax inspection result.', {
              cause
            })
          )
        }
      }
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(source)
  })
