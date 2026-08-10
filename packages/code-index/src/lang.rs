//! Per-language tables. Everything language-specific lives here as data; the
//! walker in `walk.rs` is generic over these tables. Adding a language is one
//! grammar crate plus one row.
//!
//! Node type names come from the pinned grammars and grammars occasionally
//! rename them. The language fixture tests are the source of truth: a wrong
//! entry here fails a fixture assertion rather than silently extracting nothing.

use serde::{Deserialize, Serialize};
use tree_sitter::Language as TsLanguage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Language {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    Rust,
    C,
    CSharp,
    CMake,
}

/// A node type name paired with the artifact `kind` it becomes.
pub type KindedType = (&'static str, &'static str);

pub struct Tables {
    pub classes: &'static [KindedType],
    pub functions: &'static [KindedType],
    pub imports: &'static [&'static str],
    pub calls: &'static [&'static str],
    /// Ordered field-name candidates probed for a node's name when the grammar
    /// does not expose a `name` field.
    pub name_fields: &'static [&'static str],
}

const TS_CLASSES: &[KindedType] = &[
    ("class_declaration", "class"),
    ("abstract_class_declaration", "class"),
    ("interface_declaration", "interface"),
    ("enum_declaration", "enum"),
    ("type_alias_declaration", "type"),
];
const JS_CLASSES: &[KindedType] = &[("class_declaration", "class")];
const TS_FUNCTIONS: &[KindedType] = &[
    ("function_declaration", "function"),
    ("generator_function_declaration", "function"),
    ("method_definition", "method"),
    ("variable_declarator", "function"),
];
const TS_IMPORTS: &[&str] = &["import_statement", "export_statement"];
const TS_CALLS: &[&str] = &["call_expression", "new_expression"];

impl Language {
    pub fn from_path(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        let basename = lower.rsplit('/').next().unwrap_or(&lower);
        if basename == "cmakelists.txt" {
            return Some(Self::CMake);
        }
        let extension = basename.rsplit_once('.').map(|(_, ext)| ext)?;
        Some(match extension {
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Self::JavaScript,
            "py" | "pyi" => Self::Python,
            "go" => Self::Go,
            "rs" => Self::Rust,
            "c" | "h" => Self::C,
            "cs" => Self::CSharp,
            "cmake" => Self::CMake,
            _ => return None,
        })
    }

    /// The value written to `files[path].language`. TSX collapses to
    /// `typescript`; the distinct grammar is a parsing detail, not a fact about
    /// the file worth exposing.
    pub fn name(self) -> &'static str {
        match self {
            Self::TypeScript | Self::Tsx => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Rust => "rust",
            Self::C => "c",
            Self::CSharp => "csharp",
            Self::CMake => "cmake",
        }
    }

    pub fn grammar(self) -> TsLanguage {
        match self {
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::C => tree_sitter_c::LANGUAGE.into(),
            Self::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Self::CMake => tree_sitter_cmake::LANGUAGE.into(),
        }
    }

    pub fn tables(self) -> Tables {
        match self {
            Self::TypeScript | Self::Tsx => Tables {
                classes: TS_CLASSES,
                functions: TS_FUNCTIONS,
                imports: TS_IMPORTS,
                calls: TS_CALLS,
                name_fields: &["name"],
            },
            Self::JavaScript => Tables {
                classes: JS_CLASSES,
                functions: TS_FUNCTIONS,
                imports: TS_IMPORTS,
                calls: TS_CALLS,
                name_fields: &["name"],
            },
            Self::Python => Tables {
                classes: &[("class_definition", "class")],
                functions: &[("function_definition", "function")],
                imports: &["import_statement", "import_from_statement"],
                calls: &["call"],
                name_fields: &["name"],
            },
            Self::Go => Tables {
                classes: &[("type_declaration", "type")],
                functions: &[
                    ("function_declaration", "function"),
                    ("method_declaration", "method"),
                ],
                imports: &["import_declaration"],
                calls: &["call_expression"],
                name_fields: &["name"],
            },
            Self::Rust => Tables {
                classes: &[
                    ("struct_item", "struct"),
                    ("enum_item", "enum"),
                    ("trait_item", "trait"),
                    ("union_item", "struct"),
                ],
                functions: &[("function_item", "function")],
                imports: &["use_declaration", "mod_item"],
                calls: &["call_expression", "macro_invocation"],
                name_fields: &["name"],
            },
            Self::C => Tables {
                classes: &[
                    ("struct_specifier", "struct"),
                    ("enum_specifier", "enum"),
                    ("union_specifier", "struct"),
                    ("type_definition", "type"),
                ],
                functions: &[("function_definition", "function")],
                imports: &["preproc_include"],
                calls: &["call_expression"],
                name_fields: &["name", "declarator"],
            },
            Self::CSharp => Tables {
                classes: &[
                    ("class_declaration", "class"),
                    ("interface_declaration", "interface"),
                    ("struct_declaration", "struct"),
                    ("enum_declaration", "enum"),
                    ("record_declaration", "class"),
                ],
                functions: &[
                    ("method_declaration", "method"),
                    ("constructor_declaration", "method"),
                    ("local_function_statement", "function"),
                ],
                imports: &["using_directive"],
                calls: &["invocation_expression", "object_creation_expression"],
                name_fields: &["name"],
            },
            Self::CMake => Tables {
                classes: &[],
                functions: &[("function_def", "function"), ("macro_def", "function")],
                imports: &[],
                calls: &["normal_command"],
                name_fields: &[],
            },
        }
    }

    /// Which files count as tests, for the `tested_by` mirroring in A4. C and
    /// CMake have no convention worth guessing at, so they report `false`.
    pub fn is_test_path(self, path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        let basename = lower.rsplit('/').next().unwrap_or(&lower);
        let in_directory = |segment: &str| {
            lower
                .split('/')
                .rev()
                .skip(1)
                .any(|part| part == segment.trim_matches('/'))
        };
        match self {
            Self::TypeScript | Self::Tsx | Self::JavaScript => {
                basename.contains(".test.")
                    || basename.contains(".spec.")
                    || in_directory("__tests__")
            }
            Self::Python => {
                basename.starts_with("test_")
                    || basename.ends_with("_test.py")
                    || in_directory("tests")
            }
            Self::Go => basename.ends_with("_test.go"),
            Self::Rust => in_directory("tests"),
            Self::CSharp => {
                let stem = basename.trim_end_matches(".cs");
                stem.ends_with("test") || stem.ends_with("tests")
            }
            Self::C | Self::CMake => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_languages_by_extension_and_cmake_by_filename() {
        assert_eq!(Language::from_path("src/a.tsx"), Some(Language::Tsx));
        assert_eq!(Language::from_path("CMakeLists.txt"), Some(Language::CMake));
        assert_eq!(
            Language::from_path("a/b/CMakeLists.txt"),
            Some(Language::CMake)
        );
        assert_eq!(Language::from_path("notes.md"), None);
    }

    #[test]
    fn every_language_grammar_loads() {
        for language in [
            Language::TypeScript,
            Language::Tsx,
            Language::JavaScript,
            Language::Python,
            Language::Go,
            Language::Rust,
            Language::C,
            Language::CSharp,
            Language::CMake,
        ] {
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&language.grammar())
                .unwrap_or_else(|_| panic!("{} grammar rejected", language.name()));
        }
    }

    #[test]
    fn test_paths_are_detected_per_language_convention() {
        assert!(Language::TypeScript.is_test_path("src/a.test.ts"));
        assert!(Language::TypeScript.is_test_path("src/__tests__/a.ts"));
        assert!(!Language::TypeScript.is_test_path("src/a.ts"));
        assert!(Language::Go.is_test_path("main_test.go"));
        assert!(Language::Python.is_test_path("tests/thing.py"));
        assert!(!Language::C.is_test_path("tests/thing.c"));
    }
}
