#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "mac-keychain-ssh.sh: skipping (not macOS)."
  exit 0
fi

KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
DOTENV_FILE="${DOTENV_FILE:-.env}"

if [[ -z "${KEYCHAIN_PASSWORD:-}" && -n "${SSH_USER_PWD:-}" ]]; then
  KEYCHAIN_PASSWORD="${SSH_USER_PWD}"
fi

if [[ -z "${KEYCHAIN_PASSWORD:-}" && -f "$DOTENV_FILE" ]]; then
  DOTENV_SSH_USER_PWD="$(awk -F= '
    /^[[:space:]]*SSH_USER_PWD[[:space:]]*=/ {
      val=substr($0, index($0, "=") + 1)
      sub(/\r$/, "", val)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      if ((val ~ /^".*"$/) || (val ~ /^'\''.*'\''$/)) {
        val=substr(val, 2, length(val)-2)
      }
      print val
    }
  ' "$DOTENV_FILE" | tail -n 1)"
  if [[ -n "$DOTENV_SSH_USER_PWD" ]]; then
    KEYCHAIN_PASSWORD="$DOTENV_SSH_USER_PWD"
  fi
fi

if [[ -z "${KEYCHAIN_PASSWORD:-}" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "Login keychain password: " KEYCHAIN_PASSWORD
    echo
  else
    echo "KEYCHAIN_PASSWORD or SSH_USER_PWD is required in non-interactive shells."
    exit 1
  fi
fi

echo "Preparing keychain for non-GUI codesign..."
case $KEYCHAIN_PASSWORD in
  *[[:space:]\'\"\\$\`]*)
    echo "KEYCHAIN_PASSWORD must not contain whitespace, quotes, backslashes, or expansion characters."
    exit 1
    ;;
esac
if [[ -z "$KEYCHAIN_PATH" || "$KEYCHAIN_PATH" == *$'\n'* || "$KEYCHAIN_PATH" == *$'\r'* ]]; then
  echo "KEYCHAIN_PATH must be a non-empty path without newlines." >&2
  exit 1
fi
if [[ ! -f "$KEYCHAIN_PATH" ]]; then
  echo "KEYCHAIN_PATH does not exist or is not a file: $KEYCHAIN_PATH" >&2
  exit 1
fi

# security -i parses its own command lines. Reject characters that would need
# escaping there instead of letting a path split into extra arguments.
quote_security_arg() {
  local value="$1"
  case "$value" in
    *[\'\"\\\$\`]*)
      echo "Unsupported character in keychain path: $value" >&2
      exit 1
      ;;
  esac
  printf '"%s"' "$value"
}

read_security_line() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="${value#\"}" && value="${value%\"}" ;;
  esac
  printf "%s" "$value"
}

PREVIOUS_DEFAULT="$(read_security_line "$(security default-keychain -d user 2>/dev/null || true)")"
PREVIOUS_SEARCH_LIST=()
while IFS= read -r line; do
  entry="$(read_security_line "$line")"
  if [[ -n "$entry" ]]; then
    PREVIOUS_SEARCH_LIST+=("$entry")
  fi
done < <(security list-keychains -d user 2>/dev/null || true)
if [[ ${#PREVIOUS_SEARCH_LIST[@]} -eq 0 ]]; then
  echo "Could not read the current user keychain search list." >&2
  exit 1
fi

keychain_list_contains() {
  local expected="$1"
  local line
  while IFS= read -r line; do
    [[ "$(read_security_line "$line")" == "$expected" ]] && return 0
  done < <(security list-keychains -d user 2>/dev/null || true)
  return 1
}

restore_keychains() {
  if [[ -n "$PREVIOUS_DEFAULT" ]]; then
    security default-keychain -d user -s "$PREVIOUS_DEFAULT" >/dev/null 2>&1 || true
  fi
  if [[ ${#PREVIOUS_SEARCH_LIST[@]} -gt 0 ]]; then
    security list-keychains -d user -s "${PREVIOUS_SEARCH_LIST[@]}" >/dev/null 2>&1 || true
  fi
}
trap restore_keychains EXIT

KEYCHAIN_ARG="$(quote_security_arg "$KEYCHAIN_PATH")"
LIST_ARGS="$KEYCHAIN_ARG"
for entry in "${PREVIOUS_SEARCH_LIST[@]}"; do
  [[ "$entry" == "$KEYCHAIN_PATH" ]] && continue
  LIST_ARGS="$LIST_ARGS $(quote_security_arg "$entry")"
done

# Password goes on security's stdin, not argv (ps). Prefer KEYCHAIN_PATH to a
# dedicated signing keychain; partition-list still applies to that file.
if ! security -i <<EOF
unlock-keychain -p $KEYCHAIN_PASSWORD $KEYCHAIN_ARG
set-keychain-settings -lut 21600 $KEYCHAIN_ARG
list-keychains -d user -s $LIST_ARGS
default-keychain -d user -s $KEYCHAIN_ARG
set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $KEYCHAIN_PASSWORD $KEYCHAIN_ARG
EOF
then
  echo "security could not update the keychain settings." >&2
  exit 1
fi

CURRENT_DEFAULT="$(read_security_line "$(security default-keychain -d user 2>/dev/null || true)")"
if [[ "$CURRENT_DEFAULT" != "$KEYCHAIN_PATH" ]]; then
  echo "Default keychain is $CURRENT_DEFAULT, expected $KEYCHAIN_PATH." >&2
  exit 1
fi
if ! keychain_list_contains "$KEYCHAIN_PATH"; then
  echo "Signing keychain is missing from the user search list." >&2
  exit 1
fi
for entry in "${PREVIOUS_SEARCH_LIST[@]}"; do
  if ! keychain_list_contains "$entry"; then
    echo "Previous keychain $entry was dropped from the user search list." >&2
    exit 1
  fi
done
if ! security show-keychain-info "$KEYCHAIN_PATH" >/dev/null 2>&1; then
  echo "Signing keychain is not usable after unlocking: $KEYCHAIN_PATH" >&2
  exit 1
fi

trap - EXIT
echo "Keychain ready for SSH signing."
