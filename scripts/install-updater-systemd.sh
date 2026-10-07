#!/usr/bin/env bash
# Installs (or removes) the systemd user service and timer that run the scheduled updater,
# `cc update --auto`, every five minutes (docs/update-proposal.md, section 3).
#
#   scripts/install-updater-systemd.sh               install, or update, the units
#   scripts/install-updater-systemd.sh --uninstall   disable and remove them
#   scripts/install-updater-systemd.sh --unit NAME   the daemon is the system unit NAME (default:
#                                                    detected with `systemctl is-active polaris`)
#   scripts/install-updater-systemd.sh --sudoers     also write the sudoers line a system unit needs
#   scripts/install-updater-systemd.sh --port N      the daemon listens on port N (default 8788)
#   scripts/install-updater-systemd.sh --env K=V     put CC_* variable K in the updater's environment
#
# The updater runs outside the daemon, as you, and installs only signed releases that are newer
# than what runs. Each run is cheap when there is nothing to do. Output is appended to
# command-center/data/updater.log. Lingering is enabled so the timer runs with no session open.
#
# A systemd user service carries none of your shell's environment, so the updater would look for
# the database, the backups, the secrets, the restart method, and the quiet window in their
# default places. The service reads ~/.config/polaris/updater.env (owner-only), which this script
# creates with a commented example of every CC_* variable the updater reads, and fills with any
# of them set in this script's own environment and with each --env K=V. Edit it any time; the
# next run reads it. The port is an argument to the updater, so --port goes on the ExecStart line.
#
# When the daemon is a systemd system unit, an update stops it, swaps the built dashboard (and
# restores the snapshot on a rollback), then starts it, so the updater needs sudo for exactly
# stop, start, and restart on that one unit. The script prints the line, and writes it to
# /etc/sudoers.d/polaris-updater with --sudoers, after `visudo -cf` has accepted it.
set -euo pipefail

die() { echo "install-updater-systemd: $*" >&2; exit 1; }

# Every CC_* variable `cc update --auto` reads (command-center/src/config.ts, daemon/backup.ts,
# ingest/secrets.ts, http/token.ts). The README's Automatic updates section lists the same ones.
updater_vars='CC_DB CC_BACKUP_DIR CC_SECRETS_DIR CC_UPDATE_RESTART CC_UPDATE_AT CC_TZ CC_REPO_ROOT CC_DASHBOARD_DIR CC_API_TOKEN'

uninstall=0
sudoers=0
unit=''
port=''
env_pairs=()
need_port() { [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die '--port needs a port number, like --port 8788'; }
need_env() { [ $# -gt 0 ] && [[ "$1" =~ ^CC_[A-Z0-9_]+=.*$ ]] || die '--env needs CC_NAME=value'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall=1 ;;
    --sudoers) sudoers=1 ;;
    --unit) shift; [ $# -gt 0 ] && [ -n "$1" ] || die '--unit needs a name'; unit="$1" ;;
    --unit=*) unit="${1#--unit=}"; [ -n "$unit" ] || die '--unit needs a name' ;;
    --port) shift; need_port "$@"; port="$1" ;;
    --port=*) need_port "${1#--port=}"; port="${1#--port=}" ;;
    --env) shift; need_env "$@"; env_pairs+=("$1") ;;
    --env=*) need_env "${1#--env=}"; env_pairs+=("${1#--env=}") ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$script_dir/.." && pwd)"
user="${USER:-$(id -un)}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# The unit names this file as %h/.config/polaris/updater.env, so it is under $HOME, not XDG_CONFIG_HOME.
env_file="$HOME/.config/polaris/updater.env"
service_name='polaris-updater.service'
timer_name='polaris-updater.timer'
service="$unit_dir/$service_name"
timer="$unit_dir/$timer_name"

if [ "$uninstall" = 1 ]; then
  systemctl --user disable --now "$timer_name" 2>/dev/null || true
  systemctl --user stop "$service_name" 2>/dev/null || true
  rm -f "$service" "$timer"
  systemctl --user daemon-reload
  echo "Removed $service_name and $timer_name. The sudoers line, if written, is still in /etc/sudoers.d/polaris-updater, and $env_file is left for you."
  exit 0
fi

node="$(command -v node)" || die 'node is not on PATH'
cli="$repo/command-center/src/cli.ts"
[ -f "$cli" ] || die "cannot find $cli"
data_dir="$repo/command-center/data"
log="$data_dir/updater.log"
mkdir -p "$data_dir" "$unit_dir" "$(dirname "$env_file")"

# The updater's environment, owner-only. Made once with every variable as a commented example;
# a rerun keeps what is there and only sets the variables given now, each on one line.
if [ ! -f "$env_file" ]; then
  (umask 077; cat > "$env_file" <<'EOF'
# Environment for the Polaris updater (cc update --auto), read by polaris-updater.service through
# EnvironmentFile. One NAME=value per line, no quotes and no shell expansion. Set the same values
# the daemon runs with, so the updater finds the same database, backups, and secrets. Uncomment a
# line to set it; the next run reads the file.
#CC_DB=/path/to/command-center/data/constellation.db   the database (default: command-center/data/constellation.db)
#CC_BACKUP_DIR=/path/to/backups                        where the daily backups and the pre-update snapshots go (default: data/backups)
#CC_SECRETS_DIR=/path/to/secrets                       where secrets.json lives (default: next to the database)
#CC_UPDATE_RESTART=systemd:polaris                     how the daemon is restarted: task, systemd:<unit>, systemd-user:<unit> (default: detected)
#CC_UPDATE_AT=04:00                                    when the daily check runs, HH:MM in CC_TZ (default: 04:00)
#CC_TZ=America/Chicago                                 the daemon's timezone, which CC_UPDATE_AT is read in (default: this machine's)
#CC_REPO_ROOT=/path/to/polaris                         the checkout to update (default: the one this script is in)
#CC_DASHBOARD_DIR=/path/to/polaris/dist                the built dashboard the daemon serves (default: <repo>/dist)
#CC_API_TOKEN=                                         only if the daemon runs with CC_API_TOKEN set instead of the token file
EOF
  )
fi
chmod 600 "$env_file"
set_var() {
  local tmp
  tmp="$(mktemp)"
  grep -v "^$1=" "$env_file" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  (umask 077; cat "$tmp" > "$env_file")
  rm -f "$tmp"
}
set_keys=''
for key in $updater_vars; do
  if [ -n "${!key:-}" ]; then set_var "$key" "${!key}"; set_keys="$set_keys $key"; fi
done
for pair in ${env_pairs[@]+"${env_pairs[@]}"}; do
  set_var "${pair%%=*}" "${pair#*=}"; set_keys="$set_keys ${pair%%=*}"
done

port_arg=''
[ -n "$port" ] && port_arg=" --port $port"

# The one thing the service runs. `--auto` is the scheduled mode: signed releases only, the quiet
# window, the owner's requests from the dashboard, and the status file. Nothing else is scheduled.
cat > "$service" <<EOF
[Unit]
Description=Polaris updater (cc update --auto)

[Service]
Type=oneshot
WorkingDirectory=$repo/command-center
EnvironmentFile=-%h/.config/polaris/updater.env
ExecStart="$node" "$cli" update --auto$port_arg
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
echo "Installed $timer_name: runs 'cc update --auto$port_arg' every five minutes as $user."
echo "Log: $log"
if [ -n "$set_keys" ]; then
  echo "Environment: $env_file (set now:${set_keys})"
else
  echo "Environment: $env_file (nothing set: the defaults apply; edit it to set CC_DB, CC_BACKUP_DIR, CC_SECRETS_DIR, CC_UPDATE_RESTART, or CC_UPDATE_AT)"
fi

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
