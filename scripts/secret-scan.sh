#!/usr/bin/env bash
# secret-scan.sh --staged | --tree | --history
# Fails (exit 1) on: Cloudflare token literals (cfat_/cfut_/cfk_ prefixes, Bearer + 40-char token), tracked .env
# files, local-machine paths, personal e-mail, Live View / CDP URLs with credentials, and -- when CFB_LAB_DIR points
# at the maintainer's private lab folder -- the real lab tokens and account ids (never committed).
set -o pipefail
MODE="${1:---staged}"
REPO="$(git rev-parse --show-toplevel)" || exit 2
cd "$REPO" || exit 2
TOKEN_RE='\b(cfat|cfut|cfk)_[A-Za-z0-9]{30,}|Bearer [A-Za-z0-9_-]{40}\b'
HOME_RE='/Users/[A-Za-z0-9._-]+|/home/[a-z][a-z0-9_-]+/|@gmail\.com'
URL_RE='live\.browser\.run/[^ "]*[?&](wss|jwt|token)=[A-Za-z0-9._~%-]{8,}|wss://[^ "]*/devtools/browser/[0-9a-f-]{36}'
fail=0
report() { echo "secret-scan: $1" >&2; fail=1; }

scan_stream() {
  local label="$1" text; text="$(cat)"
  [ -z "$text" ] && return 0
  printf '%s\n' "$text" | grep -E -q "$TOKEN_RE" && report "$label: Cloudflare token literal"
  printf '%s\n' "$text" | grep -E -q "$HOME_RE" && report "$label: local path or personal e-mail"
  printf '%s\n' "$text" | grep -E -q "$URL_RE" && report "$label: Live View or CDP URL"
  # maintainers: CFB_LAB_DIR (outside the repo) holds *.env files with CF_ACCOUNT_ID / CF_API_TOKEN; their values must never appear.
  local f v
  for f in "${CFB_LAB_DIR:-/nonexistent}"/*.env; do
    [ -f "$f" ] || continue
    for v in $(sed -n -E 's/^CF_(API_TOKEN|ACCOUNT_ID)=//p' "$f"); do
      [ -n "$v" ] && printf '%s\n' "$text" | grep -F -q -- "$v" && report "$label: a real lab token or account id from ${f##*/}"
    done
  done
  return 0
}
bad_env_path() { grep -E '(^|/)\.env(\..+)?$|(^|/)lab\.env$' | grep -v -E '(^|/)\.env\.example$'; }

case "$MODE" in
  --staged)
    git diff --cached --name-only --diff-filter=ACMR | bad_env_path | grep -q . && report "staged .env file"
    scan_stream "staged diff" < <(git diff --cached -U0 --diff-filter=ACMR | grep -E '^\+[^+]') ;;
  --tree)
    git ls-files -co --exclude-standard | bad_env_path | grep -q . && report "tracked/untracked-unignored .env file"
    scan_stream "tree" < <(git ls-files -co --exclude-standard -z | grep -z -v -E '(^|/)(node_modules|dist)/' | xargs -0 grep -I -h -s -E '.' 2>/dev/null) ;;
  --history)
    git rev-parse --verify -q HEAD >/dev/null || { echo "secret-scan: no commits yet"; exit 0; }
    git log --all --name-only --pretty=format: | sort -u | bad_env_path | grep -q . && report "a .env file exists in history"
    scan_stream "history" < <(git log --all -p --pretty=format: -- . ':(exclude)plugins/cf-browser/server/dist' ':(exclude)plugins/cf-browser/server/package-lock.json') ;;
  *) echo "usage: $0 --staged|--tree|--history" >&2; exit 2 ;;
esac
[ $fail = 0 ] && echo "secret-scan: clean ($MODE)"
exit $fail
