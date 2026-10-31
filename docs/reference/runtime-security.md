# Runtime advisory review

Reviewed on October 31, 2026. npm, Cargo and Go module audits do not inventory
the complete contents of native executables, Python wheels or operator-supplied
container images. These checks supplement those audits; they do not establish
that unknown vulnerabilities are absent.

## Desktop inference runtimes

The llama.cpp pin is the upstream non-prerelease [v0.8.0 release](https://github.com/ggml-org/llama.cpp/releases/tag/v0.8.0),
commit `8642541b255bfb5dc39cd351a178be09013a55d6`. The former b10419 pin was
affected by later public disclosures. Review included both the
[upstream advisory feed](https://github.com/ggml-org/llama.cpp/security/advisories)
and [NVD records](https://nvd.nist.gov/vuln/search/results?query=llama.cpp&search_type=all).
The feed alone is incomplete, and upstream also records
[incorrect version ranges](https://github.com/ggml-org/llama.cpp/issues/30786).
The following fixes were verified as ancestors of the selected commit:

| Public finding | Included upstream fix |
| --- | --- |
| CVE-2026-116829, GGUF element-count overflow | [`2149c00`](https://github.com/ggml-org/llama.cpp/commit/2149c00f4442dc59302e134a02e4c99d5f7ed9fc) |
| CVE-2026-116840, GGUF padded-size overflow | [`a6ea155`](https://github.com/ggml-org/llama.cpp/commit/a6ea155d3d38b3f6f43d0c0dc29c2d592413ef44) |
| CVE-2026-107183, chat-parser use-after-free | [`dbe4c3e`](https://github.com/ggml-org/llama.cpp/commit/dbe4c3ed42343f0a7ba0fd7e808ffeaca404d29f) |
| CVE-2026-116096, malformed Pocket-TTS projector | [`0a1ef30`](https://github.com/ggml-org/llama.cpp/commit/0a1ef309cdbb9f2024f58a38fb4c42352c5db569) |
| Deep JSON, schema, grammar and template recursion | [JSON depth rejection](https://github.com/ggml-org/llama.cpp/pull/30242), [enforced recursion limits](https://github.com/ggml-org/llama.cpp/pull/31153) |
| CVE-2026-118375 and CVE-2026-119052, RPC transport | [`9a0fde9`](https://github.com/ggml-org/llama.cpp/commit/9a0fde9967fa1a35b6e5dd1f47e1a3648b6fecc1), [`7ecb57f`](https://github.com/ggml-org/llama.cpp/commit/7ecb57f7adbea2928aa468ad2aecf05b10725ad4); RPC is also disabled |

The Pocket-TTS change turns malformed state handling into a checked failure;
the [public record](https://nvd.nist.gov/vuln/detail/CVE-2026-116096) distinguishes
that from preventing every malformed-model crash. Models remain untrusted input.

[CVE-2026-116467](https://nvd.nist.gov/vuln/detail/CVE-2026-116467) reports a
Mirostat sampler failure on non-finite probabilities; its
[upstream proposal](https://github.com/ggml-org/llama.cpp/pull/29992) was not merged.
The affected Mirostat mode is not offered or forwarded by Veil's explicit
sampling-request construction. Umbratic's local runtime receives only an
allowlisted environment and uses loopback plus a per-run bearer. This is an
applicability limit, not a claim that the underlying optional sampler is fixed.

The stable-diffusion.cpp pin is
[`0a067120b388bfefb9a87b96960cb548b97e9157`](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-1030-0a06712),
with its exact ggml submodule `6a89493756a18bd9cd8875bc4db17e329818b13f`.
The former pin's embedded ggml still contained the GGUF overflow patterns
described by CVE-2026-116829 and CVE-2026-116840. The replacement's
[GGUF reader](https://github.com/leejet/ggml/blob/6a89493756a18bd9cd8875bc4db17e329818b13f/src/gguf.cpp)
checks the incremental tensor-element product before multiplying and the byte
size before adding alignment padding. All supported targets now build this
source; no older prebuilt archive remains as a fallback.

The preceding runtime source was already a verified descendant of every fix in its six
[published advisories](https://github.com/leejet/stable-diffusion.cpp/security/advisories):
[`0a7ae07`](https://github.com/leejet/stable-diffusion.cpp/commit/0a7ae07f948eff4611968a65a22bd7c7031ad74f)
for the four PyTorch-pickle parsing reports,
[`e22272e`](https://github.com/leejet/stable-diffusion.cpp/commit/e22272ee631b742dab4440c18eb8fcafb0689402)
for safetensors offsets, and
[`4fcc6fe`](https://github.com/leejet/stable-diffusion.cpp/commit/4fcc6fef10c6f686801c6e257b22cd6a3deb906b)
for duplicate imatrix tensors. The newer source retains these fixes. This
review checks disclosed fixes and the configured source graph; it is not a
complete security analysis of all native code or operating-system GPU drivers.

Runtime download enforcement and package verification are described in
[Supply chain](supply-chain.md#the-bundled-llamacpp-runtime).

The supervised llama runtime was also exercised with the official
`ggml-org/test-model-stories260K` model at revision
`479896ec924af6d40fd419ab8f4d1eb2101de00d` (1,185,376 bytes,
SHA-256 `270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d`).
An unauthenticated request returned 401; an authenticated chat request returned
200 with 12 generated tokens, and streaming produced 14 chunks followed by
`[DONE]`. The child process was stopped after the probe. Image qualification
covers the actual CLI revision, platform/backend packaging and rejection of both
malformed GGUF fixtures. The fixed image runtime also generated a decoded,
nonblank 512×512 RGB PNG in 3.12 seconds using four CPU threads and one step with
`concedo/sdxs-512-tinySDdistilled-GGUF` at revision
`3144d898d61492f8382ffcabec055733fc5b2a0e`, Q8_0 SHA-256
`409ab23582ee074c6b9d5395784fc0741b0599fb9d138686c69087c71678eb6a`.
This exercises a small SDXS fixture, not every model family in the catalogue.

## Managed Metal server kit

The Metal kit is a separate server artifact. Its native inputs are pinned in
[`metal-native.lock.json`](../../infrastructure/veil-console/deploy/metal-native.lock.json),
its complete Python 3.12/Apple Silicon wheel closure in
[`metal-wheels.lock.json`](../../infrastructure/veil-console/deploy/metal-wheels.lock.json).
Kit construction uses a fresh staging directory and publishes only after all
checks succeed. Reusing the download cache cannot retain an older runtime in the
output. Installation remains offline, with `--no-index`, `--only-binary` and
`--require-hashes`; no source package or Git dependency is installed.

The 175-wheel closure was resolved for macOS 15/arm64 and Python 3.12 using
checksum-verified uv 0.13.6. Unchanged versions remain constrained. vLLM and its
Metal plugin move together to 0.32.0, with MLX/MLX-LM 0.32.2, MLX-VLM 0.7.6 and
MLX-Audio 0.5.2. The older audio package's transformers upper bound would make the
updated closure inconsistent. Audio extras remain enabled. Removed packages were
obsolete transitive dependencies, including the old `openai-harmony` distribution
replaced by upstream's `oss-harmony` dependency.

The review includes the [vLLM advisory feed](https://github.com/vllm-project/vllm/security/advisories),
including its [multimodal shared-memory deserialization fix](https://github.com/vllm-project/vllm/security/advisories/GHSA-6757-hggm-hp2w)
and [chat-template rendering bounds](https://github.com/vllm-project/vllm/security/advisories/GHSA-542m-9234-8gvf).
The closure also updates affected Accelerate, aiohttp, certifi, dnspython,
filelock, msgpack, multidict, OpenTelemetry, Pillow, PyJWT and urllib3 versions.
Relevant primary records include
[Pillow's decoder fixes](https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html),
[certifi's compromised-root removal](https://github.com/certifi/python-certifi/security/advisories/GHSA-6q48-6c7w-9gw2),
[urllib3's streaming fixes](https://github.com/urllib3/urllib3/security/advisories/GHSA-vxq7-64xx-v4gw)
and [filelock's Unix file handling](https://github.com/tox-dev/filelock/security/advisories/GHSA-69hj-f68j-2879).
An OSV query for every exact updated wheel version leaves the following scoped
setuptools findings; it does not prove the absence of unknown vulnerabilities.

The official vLLM CPU wheel requires exactly setuptools 78.1.1. This fixes the
[PackageIndex download traversal](https://github.com/pypa/setuptools/security/advisories/GHSA-5rjg-fvgr-3xxf)
without overriding the upstream runtime requirement. Two later advisories remain:
[macOS source-distribution exclusion](https://github.com/pypa/setuptools/security/advisories/GHSA-h35f-9h28-mq5c)
and [legacy Windows wheel installation](https://github.com/pypa/setuptools/security/advisories/GHSA-xmj3-9gf7-h52w).
The kit neither builds source distributions nor runs a Windows legacy installer;
uv installs only the reviewed, complete wheel closure. These are applicability
limits, not claims that setuptools 78.1.1 fixes those other paths.

The published Metal wheel declares a Git-only MLX-LM requirement. A reviewed
[metadata-only patch](../../infrastructure/veil-console/deploy/metal-wheel-patches/vllm-metal.json)
replaces it with the released MLX-LM 0.32.2 wheel. The release is a verified
[descendant of the required commit](https://github.com/ml-explore/mlx-lm/compare/9e6acca691e64d6d8bb808c328fcdea459099cca...v0.32.2).
Package identity and executable contents remain unchanged. The original wheel,
patch and resulting wheel have separate pinned SHA-256 values, and `RECORD` is
regenerated. The patched wheel has the explicit `1umbratic` build tag.

### Native services and codecs

| Component | Reviewed kit input | Evidence and scope |
| --- | --- | --- |
| Caddy | 2.11.7 with the reviewed source wrapper | The official binary still embeds Go 1.26.8 and affected dependencies. The kit builds with Go 1.26.10, the locked patched module graph and the reviewed legacy JOSE backport; the helper checks source and actual binary with govulncheck. The fixed proxy behavior is covered by [upstream advisories](https://github.com/caddyserver/caddy/security/advisories). |
| Qdrant | 1.20.0, official arm64 archive | The [release](https://github.com/qdrant/qdrant/releases/tag/v1.20.0) updates compromised trust roots and rejects escaping vector names. It also changes internal-auth defaults; Umbratic's Qdrant remains loopback-bound with its private API key. This is a primary release/advisory review, not a full binary-transitive audit. |
| uv | 0.13.6, official arm64 archive | Includes the [compromised CA removal](https://github.com/astral-sh/uv/security/advisories/GHSA-hq85-5cpj-mr62). Install-time network and source builds remain disabled. |
| CPython | 3.12.16+20261026, official python-build-standalone archive | Includes [3.12.16 security fixes](https://www.python.org/downloads/release/python-31216/), including compromised intermediate distrust and Expat updates. The archive's full native dependency graph is not inferred from Python's version alone. |
| Standalone FFmpeg and OpenCV's FFmpeg | Official 7.1.5 source, built for the kit | Replaces the old 7.1 executable and OpenCV's separately embedded 7.1.1 libraries. [FFmpeg's security record](https://ffmpeg.org/security.html) and the [7.1.5 security update](https://www.debian.org/security/2026/dsa-6361) describe the decoder fixes. The old imageio binary is absent from the kit. |
| PyAV | 18.1.0 wheel, embedded FFmpeg 8.1.2 | The native `av_version_info()` probe confirms 8.1.2, which includes the applicable published FFmpeg decoder fixes; this is independent of the Python package version. No unnecessary PyAV major upgrade is made. |
| TorchCodec | 0.16.0 wheel | Its FFmpeg 8 adapter is relinked to the exact already included PyAV 18.1.0 / FFmpeg 8.1.2 library set, with a private loader path and an explicit pinned PyAV dependency. No global loader override or other-major alias is added. Its other native image libraries remain a separate supply-chain surface. |

The Caddy wrapper uses Go 1.26.10, chi 5.4.0, `golang.org/x/net` 0.62.0
and JOSE v4.1.6. Legacy JOSE v3 has no upstream fixed release: the reviewed
[`third_party/go-jose-v3`](../../third_party/go-jose-v3) source backports
[empty-CBC-buffer rejection](https://github.com/go-jose/go-jose/security/advisories/GHSA-4w3g-jfj2-cw2q),
[GHSA-vvm8-gf78-28g4](https://github.com/go-jose/go-jose/security/advisories/GHSA-vvm8-gf78-28g4)
and [GHSA-mgcc-cww5-fp2q](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q).
This is a source-patched dependency, not a version-only clean result. The original
upstream race suite and four regressions pass; prepatch negative controls fail.
Source and unstripped-binary govulncheck report no reachable or imported findings;
an unimported OpenPGP module notice remains. `bin/caddy.build.json` records exact
modules, source hashes, toolchain and artifact hash, with original notices in
`runtime/notices/caddy`.

The FFmpeg 7.1.5 archive's detached signature was verified against the upstream
RSA release key `FCF986EA15E6E293A5644F10B4322F04D67658D8`; its SHA-256 is pinned.
The source build disables dependency autodetection. It uses reviewed LAME 3.101,
Opus 1.6.1 and the canonical VideoLAN x264 stable revision, plus standard macOS
frameworks. Build-only pkgconf is source-pinned and is not a runtime executable.

FFmpeg and FFprobe are both included: MLX-Audio uses FFprobe to determine stream metadata. The selected features follow actual consumers: MLX-Audio decodes M4A/AAC/WebM to
PCM and encodes MP3, FLAC and Opus/WebM; MLX-VLM writes MP4 with libx264 and AAC.
Unused external encoders from the former generic binary are not inherited.
OpenCV keeps its existing FFmpeg major ABI, with only the codec libraries replaced
and relinked. Libraries reachable solely from the obsolete FFmpeg copy are removed;
`RECORD` and the final kit hashes are regenerated. Effective native-wheel hashes
are recorded after the checked source build, alongside compiler, recipe and
source provenance, rather than represented as upstream wheel hashes.

Native license probes confirm that the original OpenCV FFmpeg libraries already
use GPL version 3 or later; the standalone imageio executable also uses a GPL
configuration. The replacement's GPL configuration includes x264 deliberately.
Original wheel notices remain, and the kit carries the reviewed corresponding
source archives, build recipe, configuration and updated codec notices under
`runtime/sources/ffmpeg` and `runtime/notices/ffmpeg`. PyAV's original native
license and notices remain separate.

These checks do not scan every vendored media library, operating-system framework,
GPU driver, or operator-provided Linux container image. Linux dependency kits are
external digest-pinned inputs; no full image vulnerability scan is claimed here.

### Offline qualification

The complete 175-package environment installed with network access disabled and
passed `uv pip check`. Real checks loaded vLLM, the Metal platform plugin,
MLX/MLX-LM/MLX-VLM/MLX-Audio, PyAV and OpenCV; exercised an MLX array operation;
and started the vLLM CLI help path without a model. Audio round trips covered WAV,
MP3, FLAC, OGG, Opus and WebM, with AAC/M4A imports. PNG/JPEG loaded through
MLX-VLM/Pillow and OpenCV. MLX-VLM encoded libx264/AAC MP4, decoded in the same
process through OpenCV, PyAV and TorchCodec, followed by FFmpeg decoding.
Python socket connections were rejected during the import/media probe. These
checks establish loading and tested media behavior, not model-specific inference
quality or hardware capacity.

The final kit's Qdrant binary also passed a loopback API probe: missing and invalid
keys were rejected, then authenticated collection/index creation, a Console-shaped
UUID point upsert, Veil's route-filtered query, document deletion and collection
deletion succeeded. Telemetry was disabled and the process and temporary key
configuration were removed after the check.

Run the same checks with
[`verify-metal-kit.py`](../../infrastructure/veil-console/deploy/verify-metal-kit.py).
The qualification uses a fresh isolated environment and downloads no models.
