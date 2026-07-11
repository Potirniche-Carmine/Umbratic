export function codeLikeIdeArgs(targetPath: string, targetKind: "file" | "folder", workspacePath?: string): string[] {
  if (targetKind === "file" && workspacePath) {
    return ["--reuse-window", workspacePath, "--goto", targetPath];
  }
  return targetKind === "file" ? [targetPath] : ["--reuse-window", targetPath];
}

export function macCodeLikeIdeArgs(targetPath: string, targetKind: "file" | "folder", workspacePath?: string): string[] {
  if (targetKind === "file" && workspacePath) {
    return ["-a", "Visual Studio Code", workspacePath, "--args", "--reuse-window", "--goto", targetPath];
  }
  return targetKind === "file"
    ? ["-a", "Visual Studio Code", targetPath]
    : ["-a", "Visual Studio Code", "--args", "--reuse-window", targetPath];
}
