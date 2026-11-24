# Notebook memory policy

Notebook memory admission reads an optional `notebook-memory-policy.json` file from the active
configuration root. The desktop and CLI profile select this root. CLI users can select one with
`--config-root /absolute/path`.

The file is read when the Notebook memory policy starts. Restart the affected backend after
changing it. A missing file uses the defaults below. Invalid JSON or invalid values also use the
defaults and write a diagnostic log entry.

## Defaults

| Platform |           Enter pressure |      Recover pressure | Physical memory caps |
| -------- | -----------------------: | --------------------: | -------------------- |
| Windows  |           2.5% available |          5% available | 400 MiB / 800 MiB    |
| Linux    |           2.5% available |          5% available | 400 MiB / 800 MiB    |
| macOS    | OS memory pressure event | Normal for 20 seconds | None                 |

The Windows and Linux caps apply to physical memory only. Commit memory continues to use the
platform ratio. Linux cgroup `max` and `high` limits remain independent execution-domain signals.
macOS uses the native `normal`, `warning`, and `critical` pressure levels instead of a percentage
threshold.

## Supported fields

```json
{
  "windowsEnterRatio": 0.025,
  "windowsExitRatio": 0.05,
  "linuxEnterRatio": 0.025,
  "linuxExitRatio": 0.05,
  "macNormalRecoveryMs": 20000
}
```

Ratios are fractions between `0.01` and `0.9`. The exit ratio must be greater than the enter
ratio. `macNormalRecoveryMs` accepts whole milliseconds from 5,000 through 300,000.

Leave a platform's ratio fields out when you want its default physical caps. Overriding either
ratio for that platform follows the existing policy configuration behavior and omits that
platform's default caps.
