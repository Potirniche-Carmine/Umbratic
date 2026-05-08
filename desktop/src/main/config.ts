import type { LocalProviderId, PermissionMode, ReasoningMode, TaskState } from "./types";

export const defaultLmStudioBaseUrl =
  process.env.AEGIS_LMSTUDIO_BASE_URL || process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1";
export const defaultVllmBaseUrl =
  process.env.AEGIS_VLLM_BASE_URL || process.env.VLLM_BASE_URL || "http://127.0.0.1:8000/v1";

export const preferredModelHints = ["gemma4", "gemma-4", "gemma"];

export const pythonRuntimeSystemPrompt =
  "Mandatory Python runtime policy: for every Python task, create or use a workspace `.venv` and run through `uv` whenever uv is available. Never verify by running bare `python`, `python3`, or `py`; those commands are not acceptable verification commands in Aegis. Use up to three concrete runtime attempts before giving up, and summarize each failed attempt with the exact command and error. Attempt 1: run `uv --version`; if uv exists, run `uv python install 3.12` if Python is missing, then `uv venv .venv --python 3.12`, then verify with `uv run python <script.py>` or the direct `.venv` interpreter. Attempt 2: if dependencies are needed, install them into the uv environment with `uv add`, `uv pip install`, or `uv run --with <package> ...`, then rerun verification through uv or `.venv`. Attempt 3: if uv is unavailable, create `.venv` with an available managed interpreter or platform launcher, then run the `.venv` interpreter directly; do not rely on shell activation. Stop after three different runtime attempts and report the conclusion instead of looping indefinitely.";

export function reasoningSystemPrompt(mode: ReasoningMode): string {
  return mode === "reasoning"
    ? "Aegis is using a reasoning-capable local model for this task. Use deliberate reasoning for ambiguous or multi-step work. If the model/provider exposes reasoning parts or reasoning_content, Aegis may display that stream live."
    : "The user disabled Think mode. Do not emit hidden reasoning, chain-of-thought, thinking-process text, or reasoning_content. Give direct answers and concise progress only.";
}

export const localProviderCatalog: Array<{
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  apiKey: string;
}> = [
  { providerId: "local-vllm", providerName: "vLLM", baseUrl: defaultVllmBaseUrl, apiKey: process.env.AEGIS_VLLM_API_KEY || process.env.VLLM_API_KEY || "aegis-local-vllm" },
  { providerId: "local-lmstudio", providerName: "LM Studio", baseUrl: defaultLmStudioBaseUrl, apiKey: "lm-studio" },
];

export const defaultDisabledProviders = [
  "opencode",
  "openai",
  "anthropic",
  "google",
  "gemini",
  "openrouter",
  "xai",
  "azure",
  "amazon-bedrock",
  "groq",
  "mistral",
  "cohere",
  "together",
  "perplexity",
];

export const taskStatesThatCanOpen = new Set<TaskState>(["running", "review_ready", "approving", "failed"]);

export function permissionRulesForMode(mode: PermissionMode) {
  return mode === "bypass"
    ? { webfetch: "deny", websearch: "deny", external_directory: "ask", edit: "allow", bash: "allow" }
    : { webfetch: "deny", websearch: "deny", external_directory: "ask", edit: "ask", bash: "ask" };
}
