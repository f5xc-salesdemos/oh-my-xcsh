#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/uat-common.sh
source "${SCRIPT_DIR}/uat-common.sh"

MODEL=${GEMINI_MODEL:-gemini-3.8-flash}
LOCATION=${VERTEX_AI_LOCATION:-global}
session_dir=$(uat_make_session gcloud)
trap 'uat_cleanup_session "$session_dir"' EXIT

uat_stage_credentials "${HOME}/.config/gcloud-host" "${session_dir}/config"
export CLOUDSDK_CONFIG="${session_dir}/config"

project=${VERTEX_AI_PROJECT:-}
if [ -z "$project" ]; then
  project=$(gcloud config get-value project 2>/dev/null || true)
fi
if [ -z "$project" ] || [ "$project" = "(unset)" ]; then
  uat_die "No Vertex AI project is configured."
fi

token=$(gcloud auth print-access-token 2>/dev/null || true)
[ -n "$token" ] || uat_die "No active Google Cloud access token is available."

payload_file="${session_dir}/request.json"
response_file="${session_dir}/response.json"
jq -n '{contents: [{role: "user", parts: [{text: "Reply with the word verified."}]}]}' >"$payload_file"

endpoint=$(uat_vertex_endpoint "$MODEL" "$project" "$LOCATION")
echo "Verifying the configured Vertex AI model..."
if ! curl --fail-with-body --silent --show-error \
  --connect-timeout 15 --max-time 120 \
  --request POST "$endpoint" \
  --header "Authorization: Bearer ${token}" \
  --header "Content-Type: application/json" \
  --data-binary "@${payload_file}" \
  --output "$response_file" 2>/dev/null; then
  unset token
  uat_die "Vertex AI authentication or model access could not be verified."
fi
unset token

if ! jq -e '.candidates[0].content.parts[0].text | type == "string" and length > 0' \
  "$response_file" >/dev/null; then
  uat_die "Vertex AI returned an unexpected response shape."
fi

echo "PASS: Vertex AI authentication is active; project and response data were not logged."
