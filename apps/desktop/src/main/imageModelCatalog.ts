import type { CatalogModel } from "./modelCatalog";

// Reviewed upstream model card and LFS digests at this immutable revision.
// Every quant includes the BF16 text encoder and the model-specific VAE.
export const imageModel: CatalogModel = {
  "id": "qwen-image-2.1",
  "kind": "image",
  "displayName": "Qwen Image 2.1",
  "hfRepo": "abenzerps/Qwen-Image-2.1-GGUF",
  "hfRevision": "c4de66efa2183fb25ecbc185bac509ee37952b41",
  "minRamGB": 32,
  "reasoning": false,
  "quants": [
    {
      "quant": "Q4_K_M",
      "files": [
        {
          "name": "qwen-image-2.1-Q4_K_M.gguf",
          "bytes": 4604557984,
          "sha256": "833439e91bc1152d28f37aa198c7f6f4218b7de95754c2f7a318a2422ab4b2f8"
        },
        {
          "name": "text_encoders/qwen3vl_8b_bf16.safetensors",
          "bytes": 17534334616,
          "sha256": "68bdc82bc1b66851162ae656225e7e2068166b603db19bd5d5a3b90eb12669a9"
        },
        {
          "name": "vae/qwen_image_2.1_vae_bf16.safetensors",
          "bytes": 675509688,
          "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
        }
      ]
    },
    {
      "quant": "Q4_0",
      "files": [
        {
          "name": "qwen-image-2.1-Q4_0.gguf",
          "bytes": 4050899616,
          "sha256": "8efd261419f4d60bf0eda8ae86a656e229ed440a248a22e20bf1f1f9606f6124"
        },
        {
          "name": "text_encoders/qwen3vl_8b_bf16.safetensors",
          "bytes": 17534334616,
          "sha256": "68bdc82bc1b66851162ae656225e7e2068166b603db19bd5d5a3b90eb12669a9"
        },
        {
          "name": "vae/qwen_image_2.1_vae_bf16.safetensors",
          "bytes": 675509688,
          "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
        }
      ]
    },
    {
      "quant": "Q5_K_M",
      "files": [
        {
          "name": "qwen-image-2.1-Q5_K_M.gguf",
          "bytes": 5221284512,
          "sha256": "88ce8e90e5b959cce5e248f697d7f6c9c7ca5696c1eac64a10dadb041dd7fd07"
        },
        {
          "name": "text_encoders/qwen3vl_8b_bf16.safetensors",
          "bytes": 17534334616,
          "sha256": "68bdc82bc1b66851162ae656225e7e2068166b603db19bd5d5a3b90eb12669a9"
        },
        {
          "name": "vae/qwen_image_2.1_vae_bf16.safetensors",
          "bytes": 675509688,
          "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
        }
      ]
    },
    {
      "quant": "Q6_K",
      "files": [
        {
          "name": "qwen-image-2.1-Q6_K.gguf",
          "bytes": 5876556448,
          "sha256": "a3a0d39bb03cda26302fc048b49d019baaea1c381cbda3994f6f2a7826344fb9"
        },
        {
          "name": "text_encoders/qwen3vl_8b_bf16.safetensors",
          "bytes": 17534334616,
          "sha256": "68bdc82bc1b66851162ae656225e7e2068166b603db19bd5d5a3b90eb12669a9"
        },
        {
          "name": "vae/qwen_image_2.1_vae_bf16.safetensors",
          "bytes": 675509688,
          "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
        }
      ]
    },
    {
      "quant": "Q8_0",
      "files": [
        {
          "name": "qwen-image-2.1-Q8_0.gguf",
          "bytes": 7591557792,
          "sha256": "9a7ec02f4c9d5cf5b78e8efa6ccd81ec0c35a898defbf8e77ac7c02a32fe0d7e"
        },
        {
          "name": "text_encoders/qwen3vl_8b_bf16.safetensors",
          "bytes": 17534334616,
          "sha256": "68bdc82bc1b66851162ae656225e7e2068166b603db19bd5d5a3b90eb12669a9"
        },
        {
          "name": "vae/qwen_image_2.1_vae_bf16.safetensors",
          "bytes": 675509688,
          "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
        }
      ]
    }
  ]
};
