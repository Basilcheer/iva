#!/usr/bin/env bash
set -Eeuo pipefail

# Beta updates for any Iva, 0.4.8 included (ADR-0018): the update branch becomes `beta`
# and iva.beta=true, in the mirror and in the checkout, then the installed updater runs.
# Nothing else is touched. Back to releases: iva stable, then iva update.
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/beta/beta.sh | bash

INSTALL_DIR="${IVA_INSTALL_DIR:-${INSTALL_DIR:-${HOME}/iva}}"

lang="en"
case "${AGENT_LANGUAGE:-}" in ru) lang="ru" ;; esac
if [ -z "${AGENT_LANGUAGE:-}" ] && [ -f "$INSTALL_DIR/.env" ]; then
  case "$(grep -E '^AGENT_LANGUAGE=' "$INSTALL_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true)" in
    ru) lang="ru" ;;
  esac
fi
say() { if [ "$lang" = "ru" ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
die() { say "Iva beta failed: $1" "Бета Iva не включена: $2" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required" "нужен git"
command -v node >/dev/null 2>&1 || die "Node.js is required" "нужен Node.js"
[ -d "$INSTALL_DIR" ] || die "Iva was not found at $INSTALL_DIR" "Iva не найдена в $INSTALL_DIR"

# Тот же поиск, что у repair.sh: версионная раскладка (current + зеркало repo) или чекаут.
entry="$INSTALL_DIR/current/bin/iva.mjs"
[ -f "$entry" ] || entry="$INSTALL_DIR/bin/iva.mjs"
[ -f "$entry" ] || die "no Iva to run in $INSTALL_DIR" "в $INSTALL_DIR нет Iva, которую можно запустить"
repos=()
if [ -f "$INSTALL_DIR/repo/HEAD" ]; then repos+=("$INSTALL_DIR/repo"); fi
if [ -d "$INSTALL_DIR/.git" ]; then repos+=("$INSTALL_DIR"); fi
[ "${#repos[@]}" -gt 0 ] || die "no git repository in $INSTALL_DIR" "в $INSTALL_DIR нет git-репозитория"

for repo in "${repos[@]}"; do
  git -C "$repo" config --local iva.updateBranch beta
  git -C "$repo" config --local iva.beta true
done

if node "$entry" update; then
  say "Iva: beta updates are on (branch beta), the update finished." "Iva: бета-обновления включены (ветка beta), обновление завершено."
else
  rc=$?
  say "Iva: beta updates are on (branch beta), the update failed (code $rc): run iva update." \
    "Iva: бета-обновления включены (ветка beta), обновление не прошло (код $rc): запустите iva update."
  exit "$rc"
fi
