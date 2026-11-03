import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import dark from "@shikijs/themes/github-dark-default";
import light from "@shikijs/themes/github-light";

import type { SourceHighlight } from "./syntaxTypes";
const extensions: Record<string, string> = {
  h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", m: "objective-c", mm: "objective-cpp",
  py: "python", pyw: "python", rb: "ruby", rs: "rust", cs: "csharp", fs: "fsharp", fsx: "fsharp",
  kt: "kotlin", kts: "kotlin", sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish",
  yml: "yaml", md: "markdown", mdx: "mdx", mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  ps1: "powershell", psm1: "powershell", pl: "perl", r: "r", ex: "elixir", exs: "elixir", erl: "erlang",
  hs: "haskell", htm: "html", tex: "latex", tf: "terraform", proto: "proto", dockerfile: "dockerfile",
  cmake: "cmake", sc: "scala", ml: "ocaml", vb: "vb", v: "v", clj: "clojure", cljs: "clojure",
};
const filenames: Record<string, string> = { dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "make", gnumakefile: "make", "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby", "cargo.lock": "toml", ".gitignore": "gitignore", ".env": "dotenv" };
export function sourceLanguage(path: string, text = ""): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() || "";
  const extension = name.split(".").pop() || "";
  const candidate = filenames[name] || (name.startsWith(".env.") ? "dotenv" : extensions[extension] || extension);
  if (Object.hasOwn(bundledLanguages, candidate)) return candidate;
  const shebang = text.split("\n", 1)[0];
  if (shebang.startsWith("#!")) {
    if (/\bpython[\d.]*(?:\s|$)/.test(shebang)) return "python";
    if (/\b(?:ba|z|da)?sh(?:\s|$)/.test(shebang)) return "shellscript";
    if (/\bnode(?:\s|$)/.test(shebang)) return "javascript";
    if (/\bruby(?:\s|$)/.test(shebang)) return "ruby";
  }
  return "text";
}

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export async function highlightSource(path: string, text: string, language?: string): Promise<SourceHighlight> {
  const hint = language?.trim().toLowerCase().split(/\s+/)[0] || "text";
  const aliases: Record<string, string> = { "c++": "cpp", "c#": "csharp", "f#": "fsharp", shell: "shellscript", console: "shellsession", terminal: "shellsession", command: "shellscript", pwsh: "powershell", ps1: "powershell", cmd: "bat" };
  const explicit = aliases[hint] || hint;
  const lang = language === undefined ? sourceLanguage(path, text) : Object.hasOwn(bundledLanguages, explicit) ? explicit : "text";
  if (lang === "text") return { language: "Plain text", lines: text.split(/\r?\n/).map(content => [{ content }]) };
  const engine = await (highlighter ??= createHighlighterCore({ themes: [dark, light], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));
  await engine.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]);
  const tokens = engine.codeToTokensWithThemes(text, { lang, themes: { dark: "github-dark-default", light: "github-light" } });
  const languageName = bundledLanguagesInfo.find(item => item.id === lang || item.aliases?.includes(lang))?.name || lang;
  return { language: languageName, lines: tokens.map(line => line.map(token => ({ content: token.content, dark: token.variants.dark.color, light: token.variants.light.color,
    italic: !!((token.variants.dark.fontStyle || 0) & 1), bold: !!((token.variants.dark.fontStyle || 0) & 2) }))) };
}
