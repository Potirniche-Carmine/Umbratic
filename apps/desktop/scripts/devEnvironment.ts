export function prepareRendererDevelopmentEnvironment(
  environment: Record<string, string | undefined>,
): void {
  environment.NODE_ENV = "development";
}
