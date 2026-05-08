#!/usr/bin/env bash
set -Eeuo pipefail

VLLM_HOME="${VLLM_HOME:-$HOME/.aegis/vllm}"
MODEL_REPO="${MODEL_REPO:-google/gemma-4-E2B-it}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-google/gemma-4-E2B-it}"
VLLM_API_KEY="${VLLM_API_KEY:-aegis-local-vllm}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-4096}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.72}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-1}"
DTYPE="${DTYPE:-float16}"
CPU_OFFLOAD_GB="${CPU_OFFLOAD_GB:-6}"

if [[ ! -x "$VLLM_HOME/bin/vllm" ]]; then
  echo "vLLM is not installed at $VLLM_HOME."
  echo "Run scripts/vllm/install-wsl-ubuntu.sh first."
  exit 1
fi

exec "$VLLM_HOME/bin/vllm" serve "$MODEL_REPO" \
  --host "$HOST" \
  --port "$PORT" \
  --api-key "$VLLM_API_KEY" \
  --served-model-name "$SERVED_MODEL_NAME" \
  --dtype "$DTYPE" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --max-num-seqs "$MAX_NUM_SEQS" \
  --cpu-offload-gb "$CPU_OFFLOAD_GB" \
  --enforce-eager \
  --enable-chunked-prefill \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --mm-processor-kwargs '{"max_soft_tokens": 70}' \
  --trust-remote-code
