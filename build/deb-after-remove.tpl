#!/bin/bash
# FPM can invoke postrm during upgrades; the replacement package owns the live registration.
case "$1" in
  remove|purge) ;;
  *) exit 0 ;;
esac

# Fail closed if another program replaced the generic link after installation.
cli_link='/usr/bin/${executable}'
if [ -e "$cli_link" ] || [ -L "$cli_link" ]; then
  if [ ! -L "$cli_link" ] || [ "$(readlink "$cli_link")" != '/etc/alternatives/${executable}' ]; then
    echo "Open Science cannot unregister its CLI: $cli_link was replaced by an unmanaged entry." >&2
    exit 1
  fi
fi
alternative_state=$(LC_ALL=C update-alternatives --query '${executable}' 2>/dev/null) || alternative_state=
if [ -n "$alternative_state" ] && ! printf '%s\n' "$alternative_state" | grep -Fxq "Link: $cli_link"; then
  echo 'Open Science cannot modify an unrelated alternatives link group.' >&2
  exit 1
fi

# Debian records the exact candidate. Do not remove the group or any other installation's entry.
update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/resources/open-science-cli' || exit "$?"

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
