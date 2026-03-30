#!/usr/bin/env bash
set -euo pipefail

# AutoResearch runner for OpenMAIC classroom generation.
#
# Emits metrics in the required format:
#   METRIC job_success=0|1
#   METRIC job_wall_time_s=<seconds>

ENV_FILE="${OPENMAIC_ENV_FILE:-$HOME/.config/papertok-study/openmaic.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

BASE_URL="${OPENMAIC_BASE_URL:-http://127.0.0.1:3006}"
TOKEN="${STUDY_API_BEARER_TOKEN:-}"
LANG="${CLASSROOM_SMOKE_LANG:-en}"
REQ="${CLASSROOM_SMOKE_REQUIREMENT:-Make a 4-scene mini-lesson about unit tests. Keep it short.}" 

start_s=$(date +%s)

auth_args=()
if [ -n "$TOKEN" ]; then
  auth_args+=( -H "Authorization: Bearer $TOKEN" )
fi

create_out=$(mktemp)
create_body=$(mktemp)

# Create job
http_code=$(curl -sS -o "$create_body" -w "%{http_code}" \
  -X POST "$BASE_URL/api/generate-classroom" \
  "${auth_args[@]}" \
  -H 'Content-Type: application/json' \
  --data "{\"requirement\":$(python3 - <<PY
import json
print(json.dumps("$REQ"))
PY
),\"language\":$(python3 - <<PY
import json
print(json.dumps("$LANG"))
PY
)}")

if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
  end_s=$(date +%s)
  echo "METRIC job_success=0"
  echo "METRIC job_wall_time_s=$((end_s-start_s))"
  exit 0
fi

job=$(python3 - <<'PY' "$create_body"
import json,sys
try:
    print(json.load(open(sys.argv[1])).get('jobId',''))
except Exception:
    print('')
PY
)

if [ -z "$job" ]; then
  end_s=$(date +%s)
  echo "METRIC job_success=0"
  echo "METRIC job_wall_time_s=$((end_s-start_s))"
  exit 0
fi

# Poll up to 30 minutes (360 * 5s).
for _ in $(seq 1 360); do
  sleep 5
  resp=$(curl -sS "${auth_args[@]}" "$BASE_URL/api/generate-classroom/$job" || true)
  st=$(python3 - <<'PY' "$resp"
import json,sys
try:
    print(json.loads(sys.argv[1]).get('status'))
except Exception:
    print('')
PY
)

  if [ "$st" = "succeeded" ] || [ "$st" = "completed" ]; then
    end_s=$(date +%s)
    echo "METRIC job_success=1"
    echo "METRIC job_wall_time_s=$((end_s-start_s))"
    exit 0
  fi
  if [ "$st" = "failed" ]; then
    end_s=$(date +%s)
    echo "METRIC job_success=0"
    echo "METRIC job_wall_time_s=$((end_s-start_s))"
    exit 0
  fi
done

end_s=$(date +%s)
echo "METRIC job_success=0"
echo "METRIC job_wall_time_s=$((end_s-start_s))"
exit 0
