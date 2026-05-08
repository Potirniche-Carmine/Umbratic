#!/usr/bin/env bash
set -Eeuo pipefail

VLLM_HOME="${VLLM_HOME:-$HOME/.aegis/vllm}"
MODEL_REPO="${MODEL_REPO:-google/gemma-4-26B-A4B-it}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-google/gemma-4-26B-A4B-it}"
VLLM_API_KEY="${VLLM_API_KEY:-aegis-local-vllm}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-32768}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-1}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"

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
  --dtype auto \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --max-num-seqs "$MAX_NUM_SEQS" \
  --tensor-parallel-size "$TENSOR_PARALLEL_SIZE" \
  --enable-prefix-caching \
  --trust-remote-code
