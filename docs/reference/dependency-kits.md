# Release dependency kits

The dependency kit is a release input, not a customer prerequisite. Its `manifest.json` contains `version`, `dependencies` (exact versions), `files` (relative path to SHA256), and, on Linux, `image` (repository plus SHA256 digest). Every kit file except the manifest must be covered. Include:

- `bin/caddy`, `bin/qdrant`, `bin/ffmpeg`: reviewed native binaries for the target. Native dynamically linked binaries need their complete runtime closure; validate them on a clean host.
- Metal: `bin/uv`, `runtime/python.tar.gz` (standalone native Python, one top-level directory), `runtime/wheels/`, and `runtime/requirements.txt` containing the complete exact, hash-locked wheel closure. No source or Git dependencies. Pin `python`, `uv`, `vllm`, `vllm-metal`, `caddy`, `qdrant`, and `ffmpeg` in `dependencies`.
- Linux: `runtime/debs/*.deb` containing Docker Engine and all required GPU/container dependencies for Ubuntu 24.04; `runtime/image.tar` containing the digest-pinned vLLM image. The host GPU driver must match the release's tested hardware configuration.

Do not release an incomplete kit. Upstream Metal may depend on unreleased MLX code; substituting a published wheel requires serving validation. A passing package checksum does not establish hardware support.

Before distribution: run the Go race tests and vet, `npm run test:all`, then install the actual ZIP on a clean target. Verify owner setup without models, trusted HTTPS enrollment, code reuse rejection, seat/device limits, model endpoints, concurrent requests, revocation, restart, redeploy, and recovery. Record OS/GPU/runtime/model versions and retain hashes. Mac startup/logout and each Linux GPU profile require their own hardware test.
