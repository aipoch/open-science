# Installing Open Science

## Download an installer

For macOS, Windows, and Linux, choose an installer from the
[latest GitHub release](https://github.com/aipoch/open-science/releases/latest).
See the [Quick Start](../README.md#-quick-start) for platform choices and first-run
setup, and [Verifying your download](../SECURITY.md#verifying-your-download) for
checksum and build-provenance verification.

## Install with Homebrew on macOS

With [Homebrew](https://brew.sh) installed, run:

```bash
brew install --cask open-science
```

The [official Homebrew cask](https://formulae.brew.sh/cask/open-science) selects the
Apple Silicon or Intel DMG and installs `Open Science.app` into `/Applications` by
default. No additional tap is needed. The cask requires macOS 12 or newer;
Homebrew has its own [system requirements](https://docs.brew.sh/Installation).
Windows and Linux users should use the release installers above.

Open the app from Applications and complete the normal first-run setup. Installing
the desktop app through Homebrew does not install the `open-science` shell command.
Enable that separately in **Settings → General → Command line tool → Install command**.

### Upgrade

Quit Open Science before upgrading through Homebrew:

```bash
brew update
brew upgrade --cask --greedy open-science
```

The cask declares `auto_updates true` because the app can update itself. `--greedy`
includes such casks in Homebrew's upgrade checks; see the
[Homebrew command reference](https://docs.brew.sh/Manpage).
The Homebrew version can lag behind GitHub Releases while a cask update is being
reviewed and published. Check the available version with `brew info --cask open-science`.

### Uninstall and application data

To remove the Homebrew-installed app while retaining application data:

```bash
brew uninstall --cask open-science
```

Only if you also want to remove the app's Homebrew-listed support files, use:

```bash
brew uninstall --cask --zap open-science
```

Back up any research data stored in these locations before using `--zap`. The cask's
zap stanza removes:

- `~/Library/Application Support/Open Science`
- `~/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.aipoch.open-science.sfl*`
- `~/Library/Caches/com.aipoch.open-science`
- `~/Library/Logs/Open Science`
- `~/Library/Preferences/com.aipoch.open-science.plist`
- `~/Library/Saved Application State/com.aipoch.open-science.savedState`

This includes application support data, logs, preferences, caches, saved state, and
recent-document metadata. It is not a complete deletion of all research data: the
cask does not list `~/.open-science`, `~/OpenScience`, or your separately configured
data location and external projects for removal.

### Existing manual installation

If Homebrew reports that `/Applications/Open Science.app` already exists, quit the
app and back up your research data. Move only that manually installed `.app` bundle
to the Trash using Finder, then run the installation command again. Keep your data
and Application Support folders. Avoid `--force` or `--zap` as a migration shortcut.
Check the version shown by `brew info --cask open-science` first so that switching
installation methods does not unintentionally install an older release.

### App appears twice in Spotlight

Check each result's location in Finder. A result in `dist/mac-arm64` can be a local
development build, while the Applications result is the installed app. Two search
results alone do not mean Homebrew installed two copies. To retain development
builds without displaying them in search, exclude the build output folder using
[Spotlight Search Privacy](https://support.apple.com/en-gb/guide/mac-help/mchl1bb43b84/mac).
Do not remove application data to fix duplicate search results.

### Homebrew cannot find the cask

Run `brew update`, then retry `brew info --cask open-science`. If the cask is still
unavailable, check connectivity to Homebrew and use the official GitHub installer
while troubleshooting. A newly merged cask or version update may take time to reach
Homebrew's published API and your local cache.
