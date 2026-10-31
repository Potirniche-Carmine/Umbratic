# Image runtime review

Reviewed 2026-09-21: upstream `leejet/stable-diffusion.cpp` release
`master-890-74988b2`, commit `74988b2`. The adjacent JSON records the official
GitHub release assets, byte lengths, and published SHA-256 digests.

The release's Qwen Image 2.1 documentation supports GGUF diffusion weights,
the Qwen3 VL text encoder and the dedicated 2.1 VAE. The live macOS test
found that this release aborts on the repository’s INT8 convrot encoder
(embedding shape / Linear scale assertion). The catalog therefore uses its
BF16 encoder; INT8 is not offered as a runnable component.
Umbratic invokes only `sd-cli`, using a private prompt file, fixed sampling
arguments, bounded dimensions, a private output directory, and no shell.
The CLI accepts no user-controlled runtime paths or switches. Runtime stdout
and stderr are discarded because they can contain private prompt text.

The macOS universal executable and its library link to system frameworks and
use Metal. Windows and Linux use the portable CPU builds for this first
release. GPU builds for those platforms need a separate dependency review.
Windows ARM64 has no reviewed upstream asset and ships without image generation;
the desktop still builds and the Image panel reports its unavailability.
The archive's CLI, libraries, and license notices are retained; its server is
not shipped. Build preparation checks the full archive digest before extraction
and verifies that the executable reports the pinned commit. No package-manager
dependency or installation lifecycle script is added.

Model files are separately pinned by immutable Hugging Face revision and LFS
SHA-256 in `imageModelCatalog.ts`. The model card lists the Qwen Research
License; runtime MIT notices are shipped with the executable.

Sources:
- https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-890-74988b2
- https://github.com/leejet/stable-diffusion.cpp/blob/74988b2/docs/qwen_image_2.1.md
- https://huggingface.co/abenzerps/Qwen-Image-2.1-GGUF/tree/c4de66efa2183fb25ecbc185bac509ee37952b41
