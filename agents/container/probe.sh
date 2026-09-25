#!/bin/sh
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() { printf 'codeboost isolation probe: %s\n' "$1" >&2; exit 78; }
mount_options() { findmnt --noheadings --output OPTIONS --target "$1" 2>/dev/null || fail "missing mount: $1"; }
has_option() { printf '%s\n' "$1" | tr ',' '\n' | grep -Fxq "$2"; }
require_option() { has_option "$(mount_options "$1")" "$2" || fail "$1 must be mounted $2"; }
filesystem_bytes() { df -B1 --output=size "$1" | tail -n 1 | tr -d ' '; }
filesystem_inodes() { df --output=itotal "$1" | tail -n 1 | tr -d ' '; }
require_ceiling() {
  # tmpfs rounds size= up to a whole page, so compare against the page-rounded limit.
  page=$(getconf PAGESIZE)
  [ "$(filesystem_bytes "$1")" -le "$(( ($2 + page - 1) / page * page ))" ] || fail "$1 exceeds its byte limit"
  [ "$(filesystem_inodes "$1")" -le "$3" ] || fail "$1 exceeds its inode limit"
}

[ "$(id -u)" -ne 0 ] || fail 'agent process must not run as root'
for field in CapInh CapPrm CapEff CapBnd CapAmb; do
  [ "$(awk -v name="$field:" '$1 == name { print $2 }' /proc/self/status)" = '0000000000000000' ] \
    || fail 'all capability sets must be empty'
done
[ "$(awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status)" = '1' ] || fail 'no-new-privileges must be enabled'
[ "$(awk '/^Seccomp:/ { print $2 }' /proc/self/status)" = '2' ] || fail 'a seccomp syscall filter must be enforced'
require_option / ro

[ "${HOME:-}" = '/home/codeboost' ] || fail 'HOME must be the isolated home directory'
[ "${CODEBOOST_PHASE:-}" != '' ] || fail 'phase is required'
[ "${CODEBOOST_VENDOR:-}" = 'codex' ] || [ "${CODEBOOST_VENDOR:-}" = 'claude' ] || fail 'vendor is required'

[ "$(findmnt --noheadings --output FSTYPE --target /work)" = 'tmpfs' ] || fail '/work must use a bounded tmpfs task filesystem'
[ "$(findmnt --noheadings --output FSTYPE --target /work/.git)" = 'tmpfs' ] || fail 'Git metadata must use a separate tmpfs filesystem'
[ "$(stat -c %d /work)" != "$(stat -c %d /work/.git)" ] || fail 'Git metadata must not alias the work filesystem'
require_ceiling /work "${CODEBOOST_WORK_BYTES:-0}" "${CODEBOOST_WORK_INODES:-0}"
require_ceiling /work/.git "${CODEBOOST_METADATA_BYTES:-0}" "${CODEBOOST_METADATA_INODES:-0}"
require_option /work/.git ro
require_option /run/codeboost-input ro
for path in /work /work/.git; do
  require_option "$path" nosuid
  require_option "$path" nodev
done

case "$CODEBOOST_PHASE" in
  planning|questions|review) require_option /work ro ;;
  execute|fix) require_option /work rw ;;
  *) fail 'unsupported phase' ;;
esac

for path in /tmp /home/codeboost; do
  [ "$(findmnt --noheadings --output FSTYPE --target "$path")" = 'tmpfs' ] || fail "$path must use tmpfs"
  require_option "$path" rw
  require_option "$path" nosuid
  require_option "$path" nodev
done
require_ceiling /tmp 33554432 4096
require_ceiling /home/codeboost 1048576 128

[ -z "$(find /home/codeboost -mindepth 1 -maxdepth 1 -print -quit)" ] || fail 'HOME must begin empty'
[ -z "$(find /tmp -mindepth 1 -maxdepth 1 -print -quit)" ] || fail '/tmp must begin empty'
[ ! -e /var/run/docker.sock ] || fail 'Docker socket must not be mounted'

case "$CODEBOOST_VENDOR" in
  codex)
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || fail 'Claude credential must not accompany Codex'
    [ "${CODEX_HOME:-}" = '/run/codeboost-auth/codex' ] || fail 'CODEX_HOME must be isolated'
    [ -f "$CODEX_HOME/auth.json" ] || fail 'Codex auth file is missing'
    require_option "$CODEX_HOME" rw
    require_option "$CODEX_HOME" nosuid
    require_option "$CODEX_HOME" nodev
    require_option "$CODEX_HOME/auth.json" ro
    require_ceiling "$CODEX_HOME" 4194304 256
    ;;
  claude)
    [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || fail 'Claude credential is missing'
    [ -z "${CODEX_HOME:-}" ] || fail 'Codex credential must not accompany Claude'
    ;;
esac

[ "$(git --version)" != '' ] || fail 'Git is unavailable'
[ "$(codex --version)" = 'codex-cli 0.153.4' ] || fail 'unexpected Codex version'
[ "$(claude --version | awk '{print $1}')" = '2.1.281' ] || fail 'unexpected Claude version'

if [ "${CODEBOOST_DEFERRED_OUTPUT:-}" = '1' ]; then
  token="$(cat /proc/sys/kernel/random/uuid)"
  printf '\036CODEBOOST_START:%s\036\n' "$token" >&2
  set +e
  "$@"
  status="$?"
  set -e
  printf '\036CODEBOOST_READY:%s:%s\036\n' "$token" "$status" >&2
  acknowledgement="/run/codeboost-output/collected-$token"
  while [ ! -e "$acknowledgement" ]; do sleep 0.05; done
  exit "$status"
fi
exec "$@"
