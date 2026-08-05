//! Token estimation mirroring `estimateTextTokens` in
//! `apps/desktop/src/shared/contextWindow.ts` so the UI meter and the
//! inspector agree on prompt cost.

pub fn estimate_text_tokens(value: &str) -> usize {
    let mut ascii_characters = 0usize;
    let mut non_ascii_bytes = 0usize;
    for character in value.chars() {
        if (character as u32) <= 0x7f {
            ascii_characters += 1;
        } else {
            non_ascii_bytes += character.len_utf8();
        }
    }
    ascii_characters.div_ceil(4) + non_ascii_bytes.div_ceil(2)
}

/// Truncates `value` on a character boundary so it fits `budget` tokens,
/// preferring to cut at a line break near the limit.
pub(crate) fn truncate_to_token_budget(value: &str, budget: usize) -> (String, bool) {
    if estimate_text_tokens(value) <= budget {
        return (value.to_owned(), false);
    }
    let mut ascii_characters = 0usize;
    let mut non_ascii_bytes = 0usize;
    let mut end = 0usize;
    for (index, character) in value.char_indices() {
        if (character as u32) <= 0x7f {
            ascii_characters += 1;
        } else {
            non_ascii_bytes += character.len_utf8();
        }
        if ascii_characters.div_ceil(4) + non_ascii_bytes.div_ceil(2) > budget {
            break;
        }
        end = index + character.len_utf8();
    }
    let head = &value[..end];
    let cut = head
        .rfind('\n')
        .filter(|at| *at * 4 >= end * 3)
        .unwrap_or(end);
    (value[..cut].trim_end().to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_counts_four_characters_per_token() {
        assert_eq!(estimate_text_tokens(""), 0);
        assert_eq!(estimate_text_tokens("abcd"), 1);
        assert_eq!(estimate_text_tokens("abcde"), 2);
    }

    #[test]
    fn non_ascii_counts_utf8_bytes() {
        // Two 2-byte characters: ceil(0/4) + ceil(4/2) = 2.
        assert_eq!(estimate_text_tokens("éé"), 2);
    }

    #[test]
    fn truncation_respects_budget_and_marks_cut() {
        let text = "line one\nline two\nline three\n".repeat(100);
        let (cut, truncated) = truncate_to_token_budget(&text, 20);
        assert!(truncated);
        assert!(estimate_text_tokens(&cut) <= 20);
        assert!(!cut.is_empty());
        let (kept, untruncated) = truncate_to_token_budget("short", 100);
        assert_eq!(kept, "short");
        assert!(!untruncated);
    }
}
