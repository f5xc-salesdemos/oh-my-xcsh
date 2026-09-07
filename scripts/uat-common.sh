#!/bin/bash

set -euo pipefail

uat_die() {
  echo "ERROR: $*" >&2
  exit 1
}

uat_make_session() {
  local prefix="$1"
  local session_dir
  session_dir=$(mktemp -d "${TMPDIR:-/tmp}/xcsh-${prefix}.XXXXXX")
  chmod 0700 "$session_dir"
  printf '%s\n' "$session_dir"
}

uat_cleanup_session() {
  local session_dir="$1"
  local base

  base=$(basename "$session_dir")
  if [ -d "$session_dir" ] && [[ "$base" == xcsh-*.?????? ]]; then
    rm -rf -- "$session_dir"
  fi
}

uat_stage_credentials() {
  local source_dir="$1"
  local destination_dir="$2"

  [ -d "$source_dir" ] || uat_die "Required read-only credential mount is unavailable."
  mkdir -p "$destination_dir"
  chmod 0700 "$destination_dir"
  cp -a "$source_dir/." "$destination_dir/"
}

uat_vertex_endpoint() {
  local model="$1"
  local project="$2"
  local location="$3"
  local host

  if [ "$location" = "global" ]; then
    host="aiplatform.googleapis.com"
  else
    host="${location}-aiplatform.googleapis.com"
  fi

  printf 'https://%s/v1/projects/%s/locations/%s/publishers/google/models/%s:generateContent\n' \
    "$host" "$project" "$location" "$model"
}
