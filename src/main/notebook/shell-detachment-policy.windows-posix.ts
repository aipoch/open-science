const maskQuotedText = (source: string, platform: NodeJS.Platform): string => {
  let quote: "'" | '"' | undefined
  let escaped = false
  let masked = ''
  for (const character of source) {
    if (escaped) {
      masked += ' '
      escaped = false
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else if ((platform === 'win32' && character === '`') || character === '\\') escaped = true
      masked += ' '
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      masked += ' '
      continue
    }
    if ((platform === 'win32' && character === '`') || character === '\\') {
      escaped = true
      masked += ' '
      continue
    }
    masked += character
  }
  return masked
}

const detachedShellMechanism = (command: string, platform: NodeJS.Platform): string | undefined => {
  const unquoted = maskQuotedText(command, platform)
  if (platform === 'win32') {
    const match = unquoted.match(
      /(?:^|[\s;|&()])(Start-Process|Start-Job|Register-ScheduledTask|schtasks|wmic\s+process\s+call\s+create)(?=$|[\s;|&()])/iu
    )
    return match?.[1]
  }

  const commandMatch = unquoted.match(
    /(?:^|[\s;|&()])(nohup|setsid|disown|daemonize|systemd-run)(?=$|[\s;|&()])/u
  )
  if (commandMatch?.[1]) return commandMatch[1]
  for (let index = 0; index < unquoted.length; index += 1) {
    if (unquoted[index] !== '&') continue
    const previous = unquoted[index - 1]
    const next = unquoted[index + 1]
    if (previous === '&' || next === '&' || previous === '>' || next === '>') continue
    return '&'
  }
  return undefined
}

export { detachedShellMechanism }
