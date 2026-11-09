export type SourceToken = { content: string; dark?: string; light?: string; italic?: boolean; bold?: boolean };
export type SourceHighlight = { language: string; lines: SourceToken[][] };
export type SyntaxDocument = { path?: string; language?: string; text: string };
export type SyntaxResults = (SourceHighlight | null)[];
export type SyntaxRequest = { id: number; documents: SyntaxDocument[] };
export type SyntaxResponse = { id: number; results: SyntaxResults };
