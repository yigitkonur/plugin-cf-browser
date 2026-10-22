#!/usr/bin/env bash
# check-links.sh -- every https URL in plugin files and docs must answer < 400 (HEAD, then GET fallback).
set -u
cd "$(git rev-parse --show-toplevel)"
fail=0
urls="$(git ls-files -co --exclude-standard 'plugins/**' '*.md' 2>/dev/null | grep -v -E 'node_modules|/dist/' | grep -E '\.(md|json)$' | xargs grep -h -o -E 'https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' 2>/dev/null | sed -E 's/[.,;:)>"'"'"'`*]+$//; s/#.*$//' | grep -v -E '<|\*\*\*|localhost|example\.com|api\.cloudflare\.com|live\.browser\.run|herokuapp|googlechromelabs|unpkg\.com|github\.com/yigitkonur/plugin-cf-browser' | sort -u)"
n=0
while IFS= read -r u; do
  [ -z "$u" ] && continue
  n=$((n+1))
  code="$(curl -s -o /dev/null -L -m 20 -w '%{http_code}' -I "$u" 2>/dev/null)"
  case "$code" in 2*|3*) ;; *) code="$(curl -s -o /dev/null -L -m 20 -w '%{http_code}' "$u" 2>/dev/null)";; esac
  case "$code" in 2*|3*) ;; *) echo "check-links: $code $u" >&2; fail=1;; esac
done <<< "$urls"
echo "check-links: checked $n URLs"
exit $fail
