#!/usr/bin/env bash
set -Eeuo pipefail

VLLM_HOME="${VLLM_HOME:-$HOME/.aegis/vllm}"
UV_BIN="${UV_BIN:-}"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi was not found in WSL."
  echo "Update your Windows NVIDIA driver, then run this again."
  exit 1
fi

if [[ -z "$UV_BIN" ]]; then
  UV_BIN="$(command -v uv || true)"
fi

if [[ -z "$UV_BIN" ]]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV_BIN="$HOME/.local/bin/uv"
fi

"$UV_BIN" self update || true
"$UV_BIN" venv "$VLLM_HOME" --python 3.12 --seed --managed-python
"$UV_BIN" pip install --python "$VLLM_HOME/bin/python" --upgrade pip wheel setuptools
"$UV_BIN" pip install --python "$VLLM_HOME/bin/python" vllm --torch-backend=auto
"$UV_BIN" pip install --python "$VLLM_HOME/bin/python" "bitsandbytes>=0.49.2" openai huggingface_hub

"$VLLM_HOME/bin/python" - <<'PY'
import torch
import vllm

print("vLLM", vllm.__version__)
print("torch", torch.__version__)
print("cuda", torch.version.cuda)
print("gpu", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "not found")
PY

echo
echo "Installed vLLM at $VLLM_HOME"
echo "Next: scripts/vllm/serve-gemma-e4b-wsl.sh"
