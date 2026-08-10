//! Import extraction. Each language states *what it wrote*; turning a
//! specifier into a workspace file is `resolve.rs`'s job, because that needs
//! the whole file set and this runs one file at a time.

use serde::{Deserialize, Serialize};
use tree_sitter::Node as TsNode;

use crate::{lang::Language, model::sanitize, walk::FileExtract};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImportKind {
    /// `./x`, `"x.h"` — resolved relative to the importing file.
    Relative,
    /// Dotted or slashed module path resolved against the project layout.
    Module,
    /// C# `using N.S` names a namespace, never a file.
    Namespace,
    /// `<stdio.h>`, `find_package(Qt)` — deliberately left unresolved.
    External,
    /// CMake `add_subdirectory(d)` → `d/CMakeLists.txt`.
    Subdirectory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawImport {
    pub specifier: String,
    pub kind: ImportKind,
    pub line: u64,
}

fn line_of(node: TsNode<'_>) -> u64 {
    node.start_position().row as u64 + 1
}

fn text_of<'a>(node: TsNode<'_>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or_default()
}

/// String literals arrive with their quotes; nothing downstream wants them.
fn unquote(value: &str) -> String {
    sanitize(
        value
            .trim()
            .trim_matches(|character| character == '"' || character == '\'' || character == '`'),
    )
}

fn push(out: &mut FileExtract, specifier: String, kind: ImportKind, line: u64) -> bool {
    if specifier.is_empty() {
        return false;
    }
    out.imports.push(RawImport {
        specifier,
        kind,
        line,
    });
    true
}

/// Returns true when the node was consumed as an import. A false result makes
/// the walker fall through to its call handling, which is what TS `require`
/// needs.
pub fn extract(language: Language, node: TsNode<'_>, source: &[u8], out: &mut FileExtract) -> bool {
    let line = line_of(node);
    match language {
        Language::TypeScript | Language::Tsx | Language::JavaScript => {
            let Some(specifier) = node.child_by_field_name("source") else {
                return false;
            };
            let specifier = unquote(text_of(specifier, source));
            let kind = if specifier.starts_with('.') {
                ImportKind::Relative
            } else {
                ImportKind::Module
            };
            push(out, specifier, kind, line)
        }
        Language::Python => {
            if let Some(module) = node.child_by_field_name("module_name") {
                return push(
                    out,
                    sanitize(text_of(module, source)),
                    ImportKind::Module,
                    line,
                );
            }
            let mut cursor = node.walk();
            let mut handled = false;
            for child in node.named_children(&mut cursor) {
                if matches!(child.kind(), "dotted_name" | "aliased_import") {
                    let name = child.child_by_field_name("name").unwrap_or(child);
                    handled |= push(
                        out,
                        sanitize(text_of(name, source)),
                        ImportKind::Module,
                        line,
                    );
                }
            }
            handled
        }
        Language::Go => {
            let mut handled = false;
            let mut cursor = node.walk();
            let mut stack: Vec<TsNode<'_>> = node.named_children(&mut cursor).collect();
            while let Some(current) = stack.pop() {
                if current.kind() == "import_spec" {
                    if let Some(path) = current.child_by_field_name("path") {
                        handled |= push(
                            out,
                            unquote(text_of(path, source)),
                            ImportKind::Module,
                            line_of(current),
                        );
                    }
                    continue;
                }
                let mut inner = current.walk();
                stack.extend(current.named_children(&mut inner));
            }
            handled
        }
        Language::Rust => {
            let field = if node.kind() == "mod_item" {
                "name"
            } else {
                "argument"
            };
            let Some(target) = node.child_by_field_name(field) else {
                return false;
            };
            push(
                out,
                sanitize(text_of(target, source)),
                ImportKind::Module,
                line,
            )
        }
        Language::C => {
            let Some(path) = node.child_by_field_name("path") else {
                return false;
            };
            let raw = text_of(path, source).trim();
            // Angle-bracket includes are system headers: external by definition.
            let kind = if raw.starts_with('<') {
                ImportKind::External
            } else {
                ImportKind::Relative
            };
            push(out, unquote(raw.trim_matches(['<', '>'])), kind, line)
        }
        Language::CSharp => {
            // `using_directive` exposes no `name` field; the namespace is the
            // last named child, after any `static`/alias prefix.
            let mut cursor = node.walk();
            let Some(name) = node
                .named_children(&mut cursor)
                .filter(|child| matches!(child.kind(), "qualified_name" | "identifier"))
                .last()
            else {
                return false;
            };
            push(
                out,
                sanitize(text_of(name, source)),
                ImportKind::Namespace,
                line,
            )
        }
        Language::CMake => false,
    }
}

/// TS/JS `require("x")` shares `call_expression` with ordinary calls, so the
/// walker asks here before treating one as a call.
pub fn extract_call_import(
    language: Language,
    node: TsNode<'_>,
    callee: TsNode<'_>,
    source: &[u8],
    out: &mut FileExtract,
) -> bool {
    if !matches!(
        language,
        Language::TypeScript | Language::Tsx | Language::JavaScript
    ) || text_of(callee, source) != "require"
    {
        return false;
    }
    let Some(arguments) = node.child_by_field_name("arguments") else {
        return false;
    };
    let mut cursor = arguments.walk();
    let Some(first) = arguments.named_children(&mut cursor).next() else {
        return false;
    };
    let specifier = unquote(text_of(first, source));
    let kind = if specifier.starts_with('.') {
        ImportKind::Relative
    } else {
        ImportKind::Module
    };
    push(out, specifier, kind, line_of(node))
}

pub fn push_cmake_import(command: &str, argument: &str, line: u64, out: &mut FileExtract) {
    let kind = match command {
        "add_subdirectory" => ImportKind::Subdirectory,
        "include" => ImportKind::Relative,
        _ => ImportKind::External,
    };
    push(out, argument.to_owned(), kind, line);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walk;

    fn imports_of(language: Language, source: &str) -> Vec<RawImport> {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language.grammar()).unwrap();
        let tree = parser.parse(source, None).unwrap();
        walk::extract(language, source.as_bytes(), &tree).imports
    }

    #[test]
    fn typescript_imports_reexports_and_requires_are_all_captured() {
        let extracted = imports_of(
            Language::TypeScript,
            "import { save } from './store';\nexport { x } from './x';\nconst y = require('./y');\n",
        );
        let specifiers: Vec<&str> = extracted.iter().map(|i| i.specifier.as_str()).collect();
        assert_eq!(specifiers, vec!["./store", "./x", "./y"]);
        assert!(extracted.iter().all(|i| i.kind == ImportKind::Relative));
    }

    #[test]
    fn c_separates_quoted_from_system_includes() {
        let extracted = imports_of(Language::C, "#include \"store.h\"\n#include <stdio.h>\n");
        assert_eq!(extracted[0].kind, ImportKind::Relative);
        assert_eq!(extracted[0].specifier, "store.h");
        assert_eq!(extracted[1].kind, ImportKind::External);
    }

    #[test]
    fn python_captures_both_import_forms() {
        let extracted = imports_of(
            Language::Python,
            "import pkg.store\nfrom pkg import store\n",
        );
        let specifiers: Vec<&str> = extracted.iter().map(|i| i.specifier.as_str()).collect();
        assert!(specifiers.contains(&"pkg.store"));
        assert!(specifiers.contains(&"pkg"));
    }

    #[test]
    fn go_import_blocks_yield_every_spec() {
        let extracted = imports_of(
            Language::Go,
            "package main\nimport (\n\t\"fmt\"\n\t\"example.com/app/store\"\n)\n",
        );
        let specifiers: Vec<&str> = extracted.iter().map(|i| i.specifier.as_str()).collect();
        assert!(specifiers.contains(&"fmt"));
        assert!(specifiers.contains(&"example.com/app/store"));
    }

    #[test]
    fn csharp_usings_are_namespaces_not_files() {
        let extracted = imports_of(Language::CSharp, "using App.Storage;\nclass A {}");
        assert_eq!(extracted[0].kind, ImportKind::Namespace);
        assert_eq!(extracted[0].specifier, "App.Storage");
    }
}
