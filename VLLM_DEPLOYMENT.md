# vLLM Setup For Aegis

## Your WSL NVIDIA 4060

1. Open Ubuntu.

2. Go to the Aegis folder:

```bash
cd /mnt/c/Users/potir/Documents/Aegis
```

3. Install vLLM:

```bash
bash scripts/vllm/install-wsl-ubuntu.sh
```

4. Start Gemma E2B:

```bash
bash scripts/vllm/serve-gemma-e2b-wsl.sh
```

5. In another Ubuntu window, test it:

```bash
cd /mnt/c/Users/potir/Documents/Aegis
bash scripts/vllm/test-chat.sh
```

6. Start Aegis from Windows:

```powershell
cd C:\Users\potir\Documents\Aegis
npm run desktop:dev
```

7. Pick `google/gemma-4-E2B-it` from the model menu.

## 4060 Settings

Use these:

```bash
MODEL_REPO=google/gemma-4-E2B-it
SERVED_MODEL_NAME=google/gemma-4-E2B-it
MAX_MODEL_LEN=4096
GPU_MEMORY_UTILIZATION=0.72
MAX_NUM_SEQS=1
CPU_OFFLOAD_GB=6
PORT=8000
VLLM_API_KEY=aegis-local-vllm
```

For more context, try this:

```bash
MAX_MODEL_LEN=8192 bash scripts/vllm/serve-gemma-e2b-wsl.sh
```

If it fails, go back to `4096`.

## E4B On A Bigger Local GPU

Use this on 12GB VRAM or more:

```bash
bash scripts/vllm/serve-gemma-e4b-wsl.sh
```

## NVIDIA Server

1. Install Docker and the NVIDIA Container Toolkit.

2. Log in to Hugging Face if needed:

```bash
export HF_TOKEN=your_huggingface_token
```

3. Run E4B:

```bash
docker run --runtime nvidia --gpus all \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  --env HF_TOKEN="$HF_TOKEN" \
  -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai:latest \
  --model google/gemma-4-E4B-it \
  --served-model-name google/gemma-4-E4B-it \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key aegis-local-vllm \
  --dtype auto \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 1 \
  --enable-prefix-caching \
  --trust-remote-code
```

4. Run 26B on a larger NVIDIA server:

```bash
docker run --runtime nvidia --gpus all \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  --env HF_TOKEN="$HF_TOKEN" \
  -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai:latest \
  --model google/gemma-4-26B-A4B-it \
  --served-model-name google/gemma-4-26B-A4B-it \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key aegis-local-vllm \
  --dtype auto \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 1 \
  --tensor-parallel-size 1 \
  --enable-prefix-caching \
  --trust-remote-code
```

5. For multi-GPU 26B, set the GPU count:

```bash
--tensor-parallel-size 2
```

## AMD Server

1. Install Docker and ROCm.

2. Log in to Hugging Face if needed:

```bash
export HF_TOKEN=your_huggingface_token
```

3. Run E4B:

```bash
docker run --device /dev/kfd --device /dev/dri \
  --group-add video \
  --security-opt seccomp=unconfined \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  --env HF_TOKEN="$HF_TOKEN" \
  -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai-rocm:latest \
  --model google/gemma-4-E4B-it \
  --served-model-name google/gemma-4-E4B-it \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key aegis-local-vllm \
  --dtype auto \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 1 \
  --enable-prefix-caching \
  --trust-remote-code
```

4. Run 26B on a larger AMD server:

```bash
docker run --device /dev/kfd --device /dev/dri \
  --group-add video \
  --security-opt seccomp=unconfined \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  --env HF_TOKEN="$HF_TOKEN" \
  -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai-rocm:latest \
  --model google/gemma-4-26B-A4B-it \
  --served-model-name google/gemma-4-26B-A4B-it \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key aegis-local-vllm \
  --dtype auto \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 1 \
  --tensor-parallel-size 1 \
  --enable-prefix-caching \
  --trust-remote-code
```

## Full Context

Use one of these:

```bash
--max-model-len 8192
--max-model-len 32768
--max-model-len 65536
--max-model-len 131072
--max-model-len 262144
```

For your 4060, use `8192`.

For E4B full context, use `131072` on a large server.

For 26B full context, use `262144` on a large multi-GPU server.

## Aegis Settings

Local Aegis:

```powershell
$env:AEGIS_VLLM_BASE_URL="http://127.0.0.1:8000/v1"
$env:AEGIS_VLLM_API_KEY="aegis-local-vllm"
npm run desktop:dev
```

Remote Aegis:

```powershell
$env:AEGIS_VLLM_BASE_URL="http://SERVER_IP:8000/v1"
$env:AEGIS_VLLM_API_KEY="aegis-local-vllm"
npm run desktop:dev
```
