/// Conversational openers that carry no meaning in a title. These are stripped
/// only from the front of a message: removing filler wherever it appears is what
/// used to reduce "can you tell me about this project" to the single word
/// "Project", which reads like a fragment rather than a title.
const leadingFiller = [
  "hey", "hi", "hello", "ok", "okay", "so", "now", "also", "please", "pls",
  "can you", "could you", "would you", "will you", "can we", "could we",
  "i want you to", "i want to", "i need you to", "i need to", "i would like you to",
  "i'd like you to", "id like you to", "i would like to", "i'd like to",
  "lets", "let's", "let us", "help me", "for me", "quick question",
  // Informational openers. These are the words every question shares, so
  // leaving them in front means a truncated title reads "Tell me about th…"
  // for every chat in the list.
  "tell me about", "tell me", "explain to me", "explain", "describe",
  "what is", "what are", "what's", "whats", "how do i", "how does", "how can i",
  "show me", "give me", "look at", "walk me through",
  // Leading articles and demonstratives left over once the opener is gone.
  "the", "this", "that", "these", "those", "a", "an", "some",
];

/// The sidebar is 230px wide and the row also carries an icon and a timestamp,
/// which leaves room for roughly this many characters before CSS ellipsis takes
/// over. A longer title is not more informative, just more truncated.
const titleLengthLimit = 32;

function stripLeadingFiller(text: string): string {
  let current = text;
  // Openers stack: "hey, can you please ..." is three of them in a row.
  for (let pass = 0; pass < 4; pass += 1) {
    const lower = current.toLowerCase();
    const match = leadingFiller.find(
      (filler) =>
        lower.startsWith(`${filler} `) || lower === filler || lower.startsWith(`${filler}, `),
    );
    if (!match) break;
    current = current.slice(match.length).replace(/^[\s,:-]+/, "");
  }
  return current;
}

/// The first sentence, or the first line when the message opens with a list or
/// a heading. A title should read like the request, not like its keywords.
function firstStatement(text: string): string {
  const line = text.split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  const sentence = line.split(/(?<=[.!?])\s+/)[0] ?? line;
  return sentence.replace(/[.!?,;:]+$/, "").trim();
}

function truncateOnWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.5 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/// Sentence case, preserving words the user capitalized deliberately —
/// identifiers, acronyms, file names, and anything already mixed case.
function sentenceCase(text: string): string {
  const first = text[0];
  if (!first || first !== first.toLowerCase()) return text;
  const [word = ""] = text.split(" ");
  // Already mixed case, or a path, file name, or qualified identifier: the user
  // wrote it that way on purpose, so capitalizing it would be wrong.
  if (word !== word.toLowerCase() || /[./\\_]|::/.test(word)) return text;
  return `${first.toUpperCase()}${text.slice(1)}`;
}

export function chatTitleFromFirstMessage(prompt: string): string {
  const body = prompt
    .split(/\n\s*\nAttached files:/i)[0]
    // Fenced code and inline markup are formatting, not title content.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[`*_>]+/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const statement = firstStatement(stripLeadingFiller(body));
  if (!statement) return "New chat";
  return truncateOnWord(sentenceCase(statement), titleLengthLimit);
}

export function stableChatTitle(existingTitle: string | undefined, firstPrompt: string): string {
  const title = existingTitle?.trim();
  return title && title !== "New chat" ? title : chatTitleFromFirstMessage(firstPrompt);
}
