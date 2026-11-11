import type { ShellRuntimeBinding } from '../../shared/notebook'

// Windows PowerShell 5.1 promotes redirected native stderr to a terminating error under Stop.
// Compile only standalone assignments whose RHS is one native capture, optionally piped to
// Out-String. Leave argument evaluation and assignment in the original PowerShell scope.
const compileNativeCapture = String.raw`& { param($source)
  $block = [ScriptBlock]::Create($source)
  $assignments = $block.Ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
      $node.Operator -eq 'Equals' -and
      $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
      ($node.Parent -is [System.Management.Automation.Language.NamedBlockAst] -or
       $node.Parent -is [System.Management.Automation.Language.StatementBlockAst]) -and
      $node.Right -is [System.Management.Automation.Language.PipelineAst]
  }, $true)
  for ($i = $assignments.Count - 1; $i -ge 0; $i--) {
    $assignment = $assignments[$i]
    $pipeline = $assignment.Right.PipelineElements
    $call = $pipeline[0]
    if ($call -isnot [System.Management.Automation.Language.CommandAst] -or
        $call.InvocationOperator -eq 'Dot' -or $call.Redirections.Count -ne 1 -or
        $call.Redirections[0].Extent.Text -notmatch '^2>(?:\s*\$null|&1)$') { continue }
    if ($pipeline.Count -gt 1 -and
        !($pipeline.Count -eq 2 -and $pipeline[1].Extent.Text -eq 'Out-String')) { continue }

    # Neither nested commands nor arbitrary expressions should run with a relaxed error policy.
    $unsafe = $call.Find({ param($n)
      if ($n -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return $n.VariablePath.UserPath -match '(?:^|:)(ErrorActionPreference|\?)$'
      }
      $n -ne $call -and $n -ne $call.Redirections[0] -and
        $n -isnot [System.Management.Automation.Language.ConstantExpressionAst] -and
        $n -isnot [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
        $n -isnot [System.Management.Automation.Language.ArrayLiteralAst] -and
        $n -isnot [System.Management.Automation.Language.CommandParameterAst]
    }, $true)
    if ($unsafe -or $call.Extent.Text.Contains('--%')) { continue }
    if ($assignment.Left.VariablePath.UserPath -match '(?:^|:)(ErrorActionPreference|LASTEXITCODE)$') { continue }

    $name = $call.GetCommandName()
    if ($name) {
      $target = "'" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($name) + "'"
    } elseif ($call.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst]) {
      $target = $call.CommandElements[0].Extent.Text
    } else { continue }
    # Class methods require scope-qualified references to external variables at parse time.
    $commands = '$global:ExecutionContext.InvokeCommand'
    $preference = '$global:ExecutionContext.SessionState.PSVariable.Get(''ErrorActionPreference'')'
    $native = '(& { param($info) if ($info -is [System.Management.Automation.AliasInfo]) { $info = $info.ResolvedCommand }; $info -is [System.Management.Automation.ApplicationInfo] } (' + $commands + '.GetCommand(' + $target + ', ''All'')))'
    $test = $preference + '.Value -eq ''Stop'' -and ' + $target + ' -is [string] -and ' + $native
    # Respect a preference the caller has explicitly locked.
    $test += ' -and !(' + $preference + '.Options -band [Management.Automation.ScopedItemOptions]''ReadOnly, Constant'')'
    $original = $assignment.Extent.Text
    $capture = $original
    if ($pipeline.Count -eq 2) {
      $test += ' -and ' + $commands + '.GetCommand(''Out-String'', ''All'') -is [System.Management.Automation.CmdletInfo]'
      $capture += ' -ErrorAction Stop'
    }
    # Set the existing variable so restoring it also preserves its original owning scope.
    $pref = $preference + '.Value'
    # Restoring the preference sets $? to true. Ignore marks the statement unsuccessful for a
    # real native failure without emitting another diagnostic or adding to the error history.
    $restore = $pref + ' = ''Stop''; if ($global:LASTEXITCODE -ne 0) { Microsoft.PowerShell.Utility\Write-Error ''Native command failed'' -ErrorAction Ignore }'
    # An explicit rethrow lets the 5.1 class parser prove the target was assigned on success.
    $replacement = 'if (' + $test + ') { try { ' + $pref + ' = ''Continue''; ' + $capture + ' } catch { throw } finally { ' + $restore + ' } } else { ' + $original + ' }'
    $source = $source.Remove($assignment.Extent.StartOffset, $original.Length).Insert($assignment.Extent.StartOffset, $replacement)
  }
  if ($source -ceq $block.ToString()) { return $block }
  [ScriptBlock]::Create($source)
}`

export function compilePowerShellCommand(
  command: string,
  sourceExpression: string,
  binding: ShellRuntimeBinding | undefined
): string {
  return binding?.kind === 'powershell' && binding.version === '5.1' && command.includes('2>')
    ? `(${compileNativeCapture} ${sourceExpression})`
    : `[ScriptBlock]::Create(${sourceExpression})`
}
