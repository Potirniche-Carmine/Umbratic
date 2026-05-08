#!/usr/bin/env bash
set -Eeuo pipefail

VLLM_API_KEY="${VLLM_API_KEY:-aegis-local-vllm}"
VLLM_BASE_URL="${VLLM_BASE_URL:-http://127.0.0.1:8000/v1}"
MODEL="${MODEL:-google/gemma-4-E2B-it}"

curl -fsS "$VLLM_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "model": "$MODEL",
  "messages": [
    { "role": "system", "content": "You are Aegis, a concise local coding assistant." },
    { "role": "user", "content": "Reply with exactly: vLLM is ready for Aegis." }
  ],
  "temperature": 0,
  "max_tokens": 32
}
JSON
