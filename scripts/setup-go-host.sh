#!/usr/bin/env sh
# Make `go/<slug>` resolve on this machine by pointing the hostname `go` at
# localhost. Idempotent: re-running does nothing if the entry already exists.
#
#   sudo scripts/setup-go-host.sh          # adds "127.0.0.1 go" to /etc/hosts
#   sudo scripts/setup-go-host.sh remove   # takes it out again
#
# Windows: run an elevated PowerShell and append the same line to
#   C:\Windows\System32\drivers\etc\hosts
#
# The hosts file only handles the *name*. Browsers still need a port unless the
# service listens on 80 — see "Reaching it as go/" in the README for the
# options (PORT=80 with setcap, a reverse proxy, or a browser search keyword).

set -eu

HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
ENTRY="127.0.0.1 go"
MARKER="# golinks"

if [ ! -w "$HOSTS_FILE" ]; then
  echo "Cannot write $HOSTS_FILE — re-run with sudo." >&2
  exit 1
fi

case "${1:-add}" in
  add)
    if grep -q "$MARKER" "$HOSTS_FILE"; then
      echo "$HOSTS_FILE already maps go -> 127.0.0.1. Nothing to do."
    else
      printf '%s %s\n' "$ENTRY" "$MARKER" >> "$HOSTS_FILE"
      echo "Added \"$ENTRY\" to $HOSTS_FILE."
    fi
    echo
    echo "Try:  curl -i http://go:3000/healthz"
    echo "Note: browsers may treat a bare 'go' as a search. Type http://go:3000/oncall"
    echo "      once and the browser will remember it, or set up the search keyword"
    echo "      described in the README."
    ;;
  remove)
    tmp="$(mktemp)"
    grep -v "$MARKER" "$HOSTS_FILE" > "$tmp"
    cat "$tmp" > "$HOSTS_FILE"
    rm -f "$tmp"
    echo "Removed the golinks entry from $HOSTS_FILE."
    ;;
  *)
    echo "Usage: $0 [add|remove]" >&2
    exit 2
    ;;
esac
