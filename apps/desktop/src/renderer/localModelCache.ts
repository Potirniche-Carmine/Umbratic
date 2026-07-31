const localModelsByBaseUrl = new Map<string, string[]>();

export function localModelCacheKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function readCachedLocalModels(baseUrl: string, selectedModel = ""): string[] {
  const key = localModelCacheKey(baseUrl);
  const cached = key ? localModelsByBaseUrl.get(key) ?? [] : [];
  return Array.from(new Set([selectedModel, ...cached].map((modelId) => modelId.trim()).filter(Boolean)));
}

export function writeCachedLocalModels(baseUrl: string, models: readonly string[]): string[] {
  const key = localModelCacheKey(baseUrl);
  const normalized = Array.from(new Set(models.map((modelId) => modelId.trim()).filter(Boolean)));
  if (key) localModelsByBaseUrl.set(key, normalized);
  return normalized;
}

export function clearCachedLocalModelsForTest(): void {
  localModelsByBaseUrl.clear();
}
