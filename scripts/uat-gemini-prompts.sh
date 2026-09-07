#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/uat-common.sh
source "${SCRIPT_DIR}/uat-common.sh"

PROMPTS_FILE=${1:-scripts/uat-prompts.json}
MODEL=${GEMINI_MODEL:-gemini-3.8-flash}
LOCATION=${VERTEX_AI_LOCATION:-global}
[ -f "$PROMPTS_FILE" ] || uat_die "The synthesized prompt fixture is unavailable."
jq -e 'type == "array" and length > 0' "$PROMPTS_FILE" >/dev/null ||
  uat_die "The synthesized prompt fixture must be a non-empty array."

session_dir=$(uat_make_session prompts)
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

endpoint=$(uat_vertex_endpoint "$MODEL" "$project" "$LOCATION")
total=$(jq 'length' "$PROMPTS_FILE")
passed=0

for ((index = 0; index < total; index++)); do
  test_id=$(jq -r ".[${index}].id" "$PROMPTS_FILE")
  expected=$(jq -r ".[${index}].expected_keyword" "$PROMPTS_FILE")
  payload_file="${session_dir}/request.json"
  response_file="${session_dir}/response.json"

  jq -n \
    --arg prompt "$(jq -r ".[${index}].prompt" "$PROMPTS_FILE")" \
    --arg instruction "$(jq -r ".[${index}].system_instruction" "$PROMPTS_FILE")" \
    '{
      systemInstruction: {parts: [{text: $instruction}]},
      contents: [{role: "user", parts: [{text: $prompt}]}]
    }' >"$payload_file"

  echo "Running synthesized prompt ${test_id}..."
  if ! curl --fail-with-body --silent --show-error \
    --connect-timeout 15 --max-time 120 \
    --request POST "$endpoint" \
    --header "Authorization: Bearer ${token}" \
    --header "Content-Type: application/json" \
    --data-binary "@${payload_file}" \
    --output "$response_file" 2>/dev/null; then
    unset token
    uat_die "Vertex AI request failed for synthesized prompt ${test_id}."
  fi

  if ! jq -er '.candidates[0].content.parts[0].text // empty' "$response_file" |
    grep -Fqi -- "$expected"; then
    unset token
    uat_die "Synthesized prompt ${test_id} did not satisfy its expected assertion."
  fi
  passed=$((passed + 1))
  echo "PASS: ${test_id}"
done

unset token
echo "PASS: ${passed}/${total} synthesized prompts passed; response data was not logged."
