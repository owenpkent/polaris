#!/usr/bin/env bash
# Installs (or removes) the systemd user service and timer that run the scheduled updater,
# `cc update --auto`, every five minutes (docs/update-proposal.md, section 3).
#
#   scripts/install-updater-systemd.sh               install, or update, the units
#   scripts/install-updater-systemd.sh --uninstall   disable and remove them
#   scripts/install-updater-systemd.sh --unit NAME   the daemon is the system unit NAME (default:
#                                                    detected with `systemctl is-active polaris`)
#   scripts/install-updater-systemd.sh --sudoers     also write the sudoers line a system unit needs
#
# The updater runs outside the daemon, as you, and installs only signed releases that are newer
# than what runs. Each run is cheap when there is nothing to do. Output is appended to
# command-center/data/updater.log. Lingering is enabled so the timer runs with no session open.
#
# When the daemon is a systemd system unit, an update stops it, swaps the built dashboard (and
# restores the snapshot on a rollback), then starts it, so the updater needs sudo for exactly
# stop, start, and restart on that one unit. The script prints the line, and writes it to
# /etc/sudoers.d/polaris-updater with --sudoers, after `visudo -cf` has accepted it.
set -euo pipefail

die() { echo "install-updater-systemd: $*" >&2; exit 1; }

uninstall=0
sudoers=0
unit=''
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall=1 ;;
    --sudoers) sudoers=1 ;;
    --unit) shift; [ $# -gt 0 ] && [ -n "$1" ] || die '--unit needs a name'; unit="$1" ;;
    --unit=*) unit="${1#--unit=}"; [ -n "$unit" ] || die '--unit needs a name' ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$script_dir/.." && pwd)"
user="${USER:-$(id -un)}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_name='polaris-updater.service'
timer_name='polaris-updater.timer'
service="$unit_dir/$service_name"
timer="$unit_dir/$timer_name"

if [ "$uninstall" = 1 ]; then
  systemctl --user disable --now "$timer_name" 2>/dev/null || true
  systemctl --user stop "$service_name" 2>/dev/null || true
  rm -f "$service" "$timer"
  systemctl --user daemon-reload
  echo "Removed $service_name and $timer_name. The sudoers line, if written, is still in /etc/sudoers.d/polaris-updater."
  exit 0
fi

node="$(command -v node)" || die 'node is not on PATH'
cli="$repo/command-center/src/cli.ts"
[ -f "$cli" ] || die "cannot find $cli"
data_dir="$repo/command-center/data"
log="$data_dir/updater.log"
mkdir -p "$data_dir" "$unit_dir"

# The one thing the service runs. `--auto` is the scheduled mode: signed releases only, the quiet
# window, the owner's requests from the dashboard, and the status file. Nothing else is scheduled.
cat > "$service" <<EOF
[Unit]
Description=Polaris updater (cc update --auto)

[Service]
Type=oneshot
WorkingDirectory=$repo/command-center
ExecStart="$node" "$cli" update --auto
StandardOutput=append:$log
StandardError=append:$log
EOF

cat > "$timer" <<EOF
[Unit]
Description=Run the Polaris updater every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$timer_name"
echo "Installed $timer_name: runs 'cc update --auto' every five minutes as $user."
echo "Log: $log"

# Without lingering, user units stop with the last session and the quiet window is missed.
if loginctl enable-linger "$user" 2>/dev/null; then
  echo "Lingering is on for $user, so the timer runs with no session open."
else
  echo "Could not enable lingering (no rights). Run this once, as root, or the timer only runs while you are logged in:"
  echo "  sudo loginctl enable-linger $user"
fi

if [ -z "$unit" ] && systemctl is-active --quiet polaris 2>/dev/null; then
  unit='polaris'
fi

if [ -n "$unit" ]; then
  systemctl_path="$(command -v systemctl)" || die 'cannot find systemctl'
  # Exactly three verbs on the one unit: the update stops the daemon, swaps the built dashboard
  # (and restores the snapshot on a rollback), then starts it; restart is the simple case.
  line="$user ALL=(root) NOPASSWD: $systemctl_path stop $unit, $systemctl_path start $unit, $systemctl_path restart $unit"
  echo "The daemon is the system unit '$unit'. The updater needs this sudoers line:"
  echo "  $line"
  if [ "$sudoers" = 1 ]; then
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    printf '%s\n' "$line" > "$tmp"
    sudo visudo -cf "$tmp" >/dev/null || die 'visudo rejected the line; nothing was written'
    sudo install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/polaris-updater
    echo "Written to /etc/sudoers.d/polaris-updater."
  else
    echo "Add it with visudo, or run this script again with --sudoers to write /etc/sudoers.d/polaris-updater."
  fi
fi

echo "Remove the units with:"
echo "  $script_dir/install-updater-systemd.sh --uninstall"
