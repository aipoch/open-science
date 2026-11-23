param([string]$ReleaseVersion, [string]$LastSuccess)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$releases = gh api --paginate --slurp "repos/$env:GITHUB_REPOSITORY/releases?per_page=100" | ConvertFrom-Json
$candidates = foreach ($page in $releases) {
  foreach ($release in $page) {
    if (!$release.draft -and !$release.prerelease -and $release.tag_name -cmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
      if ($ReleaseVersion -and ([version]$release.tag_name.Substring(1) -ge [version]$ReleaseVersion -or
          !(@($release.assets.name) -clike '*-win-x64-setup.exe'))) { continue }
      $release
    }
  }
}
$baseline = $candidates | Sort-Object { [version]$_.tag_name.Substring(1) } -Descending | Select-Object -First 1
if (!$baseline) { throw "No published stable baseline for candidate $ReleaseVersion" }
$tag = $baseline.tag_name
$stable = [version]$tag.Substring(1)
if ($ReleaseVersion) {
  $installers = @($baseline.assets | Where-Object { $_.name -clike '*-win-x64-setup.exe' })
  if ($installers.Count -ne 1) { throw "Expected one Windows x64 installer in $tag" }
  $blockmap = "$($installers[0].name).blockmap"
  if ($baseline.assets.name -cnotcontains $blockmap) { throw "Windows baseline $tag is missing $blockmap" }
}
$base = git rev-parse --verify "$tag^{commit}"
git merge-base --is-ancestor $base HEAD
$compare = if ($LastSuccess) { $LastSuccess } else { $base }
# Compare the full untested interval. A failed scheduled run must not advance this boundary.
$paths = @('src/main/update/', ':(glob)src/main/**/*update*', ':(glob)src/shared/**/*update*',
  'src/main/desktop-runtime-launcher.ts', 'src/main/node-entry.ts', 'src/main/desktop-entry.ts',
  'packages/open-science/cli.mjs', 'packages/open-science/installation-startup.cjs',
  'packages/open-science/launch-log.mjs', 'packages/process-tree-native/',
  ':(glob)src/main/**/*occupancy*', ':(glob)packages/**/*handoff*', ':(glob)packages/**/*occupancy*',
  'build/', 'electron-builder.yml', 'patches/', 'package.json', 'package-lock.json',
  'scripts/windows-updater-certification.mjs', 'scripts/ci/build-upgrade-fixture.ps1',
  'scripts/ci/plan-windows-upgrade.ps1', '.github/workflows/daily-windows-upgrade.yml')
$changed = @(git diff --name-only $compare HEAD -- @paths)
"baseline=$tag" >> $env:GITHUB_OUTPUT
"baseline_sha=$base" >> $env:GITHUB_OUTPUT
"version_a=$stable" >> $env:GITHUB_OUTPUT
"version_b=$($stable.Major).$($stable.Minor).$($stable.Build + 1)" >> $env:GITHUB_OUTPUT
"version_c=$($stable.Major).$($stable.Minor).$($stable.Build + 2)" >> $env:GITHUB_OUTPUT
"forward=$([bool]$changed.Count)".ToLowerInvariant() >> $env:GITHUB_OUTPUT
"Baseline $tag ($base), candidate $env:GITHUB_SHA. Updater or packaging changes since $compare : $($changed -join ', ')" >> $env:GITHUB_STEP_SUMMARY
