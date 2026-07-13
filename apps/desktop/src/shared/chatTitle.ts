const titleStopWords = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "are",
  "at",
  "be",
  "can",
  "could",
  "does",
  "each",
  "every",
  "exactly",
  "for",
  "give",
  "i",
  "in",
  "is",
  "it",
  "let",
  "lets",
  "look",
  "make",
  "me",
  "more",
  "my",
  "of",
  "on",
  "please",
  "should",
  "specific",
  "tell",
  "that",
  "the",
  "this",
  "to",
  "us",
  "want",
  "we",
  "what",
  "with",
  "would",
  "you",
]);

function titleWord(word: string): string {
  if (!word) return word;
  if (word === word.toUpperCase() || word.includes("_") || word.includes("-")) return word;
  return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}

export function chatTitleFromFirstMessage(prompt: string): string {
  const text = prompt
    .split(/\n\s*\nAttached files:/i)[0]
    .replace(/[`*_#[\]()>.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) ?? [];
  const summaryWords = words
    .filter((word) => !titleStopWords.has(word.toLowerCase().replace(/'s$/, "")))
    .slice(0, 3);
  const selectedWords = summaryWords.length >= 2 ? summaryWords : words.slice(0, 3);
  const title = selectedWords.map(titleWord).join(" ");
  return title ? title.slice(0, 72) : "New chat";
}

export function stableChatTitle(existingTitle: string | undefined, firstPrompt: string): string {
  const title = existingTitle?.trim();
  return title && title !== "New chat" ? title : chatTitleFromFirstMessage(firstPrompt);
}
