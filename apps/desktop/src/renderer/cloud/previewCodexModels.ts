import type { CloudModel } from "../../shared/cloud";

// Design-only snapshot of the installed Codex model/list response on 2026-11-02.
// Production always queries the runtime; no account data is included here.
export const previewCodexModels: CloudModel[] = [
  {
    "id": "gpt-6.1-sol",
    "label": "GPT-6.1-Sol",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ],
    "defaultEffort": "low"
  },
  {
    "id": "gpt-6-astra",
    "label": "GPT-6-Astra",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ],
    "defaultEffort": "medium"
  },
  {
    "id": "gpt-6.1-terra",
    "label": "GPT-6.1 Terra",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ],
    "defaultEffort": "low"
  },
  {
    "id": "gpt-6-sol",
    "label": "GPT-6-Sol",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ],
    "defaultEffort": "medium"
  },
  {
    "id": "gpt-6-luna",
    "label": "GPT-6-Luna",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "defaultEffort": "medium"
  },
  {
    "id": "gpt-5.6-sol",
    "label": "GPT-5.6-Sol",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ],
    "defaultEffort": "low"
  },
  {
    "id": "gpt-5.6-terra",
    "label": "GPT-5.6-Terra",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ],
    "defaultEffort": "medium"
  },
  {
    "id": "gpt-5.6-luna",
    "label": "GPT-5.6-Luna",
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "defaultEffort": "medium"
  }
];
