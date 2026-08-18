/// Conversational openers that carry no meaning in a title. These are stripped
/// only from the front of a message: removing filler wherever it appears is what
/// used to reduce "can you tell me about this project" to the single word
/// "Project", which reads like a fragment rather than a title.
///
/// Longest first, so "hey there" is one opener rather than "hey" followed by a
/// word that starts the title. The sort is done here rather than trusted to the
/// order somebody types a new entry in.
const leadingFiller = [
  "hey", "hi", "hello", "yo", "howdy", "ok", "okay", "so", "now", "also", "please", "pls",
  // Greetings that end in a word which is not a subject. "Hey there, fix the
  // build" opens with two words of nothing, and stripping only the first left
  // every one of them titled "There".
  "hey there", "hi there", "hello there", "good morning", "good afternoon", "good evening",
  "can you", "could you", "would you", "will you", "can we", "could we",
  "i want you to", "i want to", "i need you to", "i need to", "i would like you to",
  "i'd like you to", "id like you to", "i would like to", "i'd like to",
  "lets", "let's", "let us", "help me", "for me", "quick question",
  "i was wondering", "i wonder", "do you know", "any idea", "any ideas",
  // Informational openers. These are the words every question shares, so
  // leaving them in front means a truncated title reads "Tell me about th…"
  // for every chat in the list.
  "tell me about", "tell me", "explain to me", "explain", "describe",
  "what is", "what are", "what's", "whats", "how do i", "how does", "how can i",
  "show me", "give me", "look at", "walk me through",
  // Leading articles and demonstratives left over once the opener is gone.
  "the", "this", "that", "these", "those", "a", "an", "some",
].sort((left, right) => right.length - left.length);

/// Words that end a request without adding to it. "Fix the build please" and
/// "fix the build" are the same chat.
const trailingFiller = ["please", "pls", "thanks", "thank you", "thx", "for me", "asap"];

/// Tokens whose full stop is part of the word rather than the end of a
/// sentence. Without them "use e.g. a mutex" titles a chat "Use e.g".
const abbreviations = new Set(["e.g", "i.e", "etc", "vs", "approx", "fig", "no", "mr", "mrs", "ms", "dr", "st"]);

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
  // An enumerator left at the front once the opener is gone: "tell me 1. what
  // the runner does" is one request that happens to be numbered, not a title
  // that starts with a digit. The trailing space is what keeps "3.5 vs 4"
  // whole.
  return current.replace(/^\d+[.)]\s+/, "");
}

function stripTrailingFiller(text: string): string {
  let current = text;
  for (let pass = 0; pass < 2; pass += 1) {
    const lower = current.toLowerCase();
    const match = trailingFiller.find((filler) => lower.endsWith(` ${filler}`) || lower.endsWith(`, ${filler}`));
    if (!match) break;
    current = current.slice(0, current.length - match.length).replace(/[\s,]+$/, "");
  }
  return current;
}

/// Whether a full stop here ends a sentence or belongs to the word in front of
/// it. "Step 1. open the file" and "v1.2 broke" are one statement, not two, and
/// splitting them is what titled chats "There tell me 1".
function endsSentence(upToPunctuation: string): boolean {
  const punctuation = upToPunctuation[upToPunctuation.length - 1];
  if (punctuation !== ".") return true;
  const token = (upToPunctuation.split(/\s/).pop() ?? "").replace(/\.$/, "").toLowerCase();
  return !/[0-9]$/.test(token) && !abbreviations.has(token);
}

/// The first sentence of a line. A title should read like the request, not like
/// its keywords.
function firstSentence(line: string): string {
  for (const match of line.matchAll(/[.!?](?=\s)/g)) {
    const upTo = line.slice(0, match.index + 1);
    if (endsSentence(upTo)) return upTo.replace(/[.!?,;:]+$/, "").trim();
  }
  return line.replace(/[.!?,;:]+$/, "").trim();
}

/// The line the title comes from.
///
/// Usually the first, but a message that opens on its own line of greeting —
/// "hey!\ncan you fix the build" — has its subject on the second, and titling
/// every such chat "Hey" tells the sidebar nothing. So the first line that
/// still says something once its openers are gone wins, and the plain first
/// line is the fallback when none of them do.
function titleStatement(text: string): string {
  const lines = text.split("\n").map((value) => value.trim()).filter(Boolean);
  for (const line of lines) {
    const statement = stripTrailingFiller(firstSentence(stripLeadingFiller(line)));
    if (statement.length >= 4 || statement.split(" ").length > 1) return statement;
  }
  return stripTrailingFiller(firstSentence(lines[0] ?? ""));
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
    // Ordered list markers too, and only at the head of a line: "1. what the
    // runner does" is a numbered request, while "1 thing about retries" counts
    // something and has to keep its number.
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[`*_>]+/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const statement = titleStatement(body);
  if (!statement) return "New chat";
  return truncateOnWord(sentenceCase(statement), titleLengthLimit);
}

export function stableChatTitle(existingTitle: string | undefined, firstPrompt: string): string {
  const title = existingTitle?.trim();
  return title && title !== "New chat" ? title : chatTitleFromFirstMessage(firstPrompt);
}
