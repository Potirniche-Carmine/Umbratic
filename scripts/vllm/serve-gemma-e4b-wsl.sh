#!/usr/bin/env bash
set -Eeuo pipefail

VLLM_HOME="${VLLM_HOME:-$HOME/.aegis/vllm}"
MODEL_REPO="${MODEL_REPO:-ciocan/gemma-4-E4B-it-W4A16}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-google/gemma-4-E4B-it}"
VLLM_API_KEY="${VLLM_API_KEY:-aegis-local-vllm}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.80}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-1}"
DTYPE="${DTYPE:-float16}"
QUANTIZATION="${QUANTIZATION:-gptq_marlin}"

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
  --quantization "$QUANTIZATION" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --max-num-seqs "$MAX_NUM_SEQS" \
  --enforce-eager \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --trust-remote-code
