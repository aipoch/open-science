FROM node:24-bookworm AS node
FROM ubuntu:24.04
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libdrm2 libxtst6 libx11-xcb1 libxkbcommon0 libsecret-1-0 libnotify4 libatspi2.0-0t64 xvfb xauth gnome-keyring dbus-x11 shared-mime-info desktop-file-utils libglib2.0-bin zlib1g-dev libsecret-tools xdotool libfuse2t64 && rm -rf /var/lib/apt/lists/*
