//! One recursive descent shared by every language (A1.1). Node type names are
//! looked up in the per-language tables; the only language-specific code here
//! is the escape-hatch set in A1.3, each of which encodes one grammar
//! irregularity rather than a general rule.

use serde::{Deserialize, Serialize};
use tree_sitter::Node as TsNode;

use crate::{
    imports::{self, RawImport},
    lang::{Language, Tables},
    model::sanitize,
};

/// Pathological or generated files produce very deep trees; bailing out costs
/// the tail of one file, never the build.
const MAX_AST_DEPTH: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSymbol {
    pub kind: String,
    pub name: String,
    pub parent: Option<String>,
    pub start_line: u64,
    pub end_line: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawCall {
    /// Bare final segment — what resolution matches on.
    pub name: String,
    /// The callee text as written, kept for edge evidence.
    pub text: String,
    /// Index into `FileExtract::symbols` of the enclosing symbol, if any.
    pub from: Option<usize>,
    pub line: u64,
}

/// A relation discovered syntactically rather than through call resolution:
/// Rust `impl Trait for Type`, CMake `target_link_libraries`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawRelation {
    pub relation: String,
    pub from_name: String,
    pub to_name: String,
    pub line: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileExtract {
    pub symbols: Vec<RawSymbol>,
    pub calls: Vec<RawCall>,
    pub imports: Vec<RawImport>,
    pub relations: Vec<RawRelation>,
    /// C# namespaces declared in this file, feeding the `using` index in A3
    /// stage 3. Empty for every other language.
    pub namespaces: Vec<String>,
}

struct Walker<'a> {
    source: &'a [u8],
    language: Language,
    tables: Tables,
    out: FileExtract,
    /// C# `namespace` prefix for qualified names; empty elsewhere.
    namespace: Option<String>,
}

pub fn extract(language: Language, source: &[u8], tree: &tree_sitter::Tree) -> FileExtract {
    let mut walker = Walker {
        source,
        language,
        tables: language.tables(),
        out: FileExtract::default(),
        namespace: None,
    };
    walker.walk(tree.root_node(), None, None, 0);
    walker.out
}

fn text_of<'a>(node: TsNode<'_>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or_default()
}

/// The bare final segment of a dotted, `::`-separated, or arrow-separated
/// expression. `store.save` and `Store::save` both resolve on `save`.
fn bare_name(text: &str) -> String {
    let head = text.split(['\n', '(', '<', '{']).next().unwrap_or(text);
    let last = head.rsplit(['.', '!']).next().unwrap_or(head);
    let last = last.rsplit("::").next().unwrap_or(last);
    let last = last.rsplit("->").next().unwrap_or(last);
    last.trim()
        .trim_matches(|character: char| !character.is_alphanumeric() && character != '_')
        .to_owned()
}

impl Walker<'_> {
    fn line(&self, node: TsNode<'_>) -> (u64, u64) {
        // tree-sitter rows are 0-based; the artifact is 1-based. Converted once,
        // here, so no downstream code has to remember which convention it holds.
        (
            node.start_position().row as u64 + 1,
            node.end_position().row as u64 + 1,
        )
    }

    fn named_child_text(&self, node: TsNode<'_>) -> Option<String> {
        for field in self.tables.name_fields {
            if let Some(child) = node.child_by_field_name(field) {
                let name = self.unwrap_declarator(child);
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        None
    }

    /// C hides function names inside nested pointer/function declarators
    /// (A1.3); everywhere else this returns the node's own text.
    fn unwrap_declarator(&self, node: TsNode<'_>) -> String {
        let mut current = node;
        while matches!(
            current.kind(),
            "pointer_declarator"
                | "function_declarator"
                | "array_declarator"
                | "parenthesized_declarator"
                | "init_declarator"
        ) {
            let Some(child) = current.child_by_field_name("declarator") else {
                break;
            };
            current = child;
        }
        sanitize(text_of(current, self.source))
    }

    fn push_symbol(
        &mut self,
        kind: &str,
        name: String,
        parent: Option<String>,
        node: TsNode<'_>,
    ) -> usize {
        let (start_line, end_line) = self.line(node);
        self.out.symbols.push(RawSymbol {
            kind: kind.to_owned(),
            name: sanitize(&name),
            parent,
            start_line,
            end_line,
        });
        self.out.symbols.len() - 1
    }

    /// The member being called, taken from the grammar rather than from the
    /// text. Text parsing gets `new Store().Save` wrong — the argument list's
    /// `(` arrives before the `.` — and every grammar already labels the
    /// member field, so ask it.
    fn callee_member<'b>(&self, callee: TsNode<'b>) -> Option<TsNode<'b>> {
        for field in ["name", "property", "field", "attribute", "selector"] {
            if let Some(child) = callee.child_by_field_name(field) {
                return Some(child);
            }
        }
        None
    }

    fn push_call(&mut self, callee: TsNode<'_>, from: Option<usize>, node: TsNode<'_>) {
        let text = sanitize(text_of(callee, self.source));
        let name = match self.callee_member(callee) {
            Some(member) => bare_name(text_of(member, self.source)),
            None => bare_name(&text),
        };
        if name.is_empty() {
            return;
        }
        self.out.calls.push(RawCall {
            name,
            text,
            from,
            line: self.line(node).0,
        });
    }

    fn callee_of<'b>(&self, node: TsNode<'b>) -> Option<TsNode<'b>> {
        for field in ["function", "constructor", "type", "macro", "name"] {
            if let Some(child) = node.child_by_field_name(field) {
                return Some(child);
            }
        }
        None
    }

    fn walk(
        &mut self,
        node: TsNode<'_>,
        enclosing_class: Option<String>,
        enclosing_symbol: Option<usize>,
        depth: usize,
    ) {
        if depth > MAX_AST_DEPTH {
            return;
        }
        let mut cursor = node.walk();
        let children: Vec<TsNode<'_>> = node.children(&mut cursor).collect();
        for child in children {
            if self.escape_hatch(child, enclosing_class.clone(), enclosing_symbol, depth) {
                continue;
            }
            let kind = child.kind();
            if let Some((_, node_kind)) = self.tables.classes.iter().find(|(name, _)| *name == kind)
            {
                let node_kind = *node_kind;
                let Some(name) = self.named_child_text(child) else {
                    // A node with no resolvable name is skipped, not invented.
                    self.walk(child, enclosing_class.clone(), enclosing_symbol, depth + 1);
                    continue;
                };
                let index =
                    self.push_symbol(node_kind, name.clone(), enclosing_class.clone(), child);
                self.walk(child, Some(name), Some(index), depth + 1);
            } else if let Some((_, node_kind)) =
                self.tables.functions.iter().find(|(name, _)| *name == kind)
            {
                let node_kind = *node_kind;
                if kind == "variable_declarator" && !self.is_function_value(child) {
                    self.walk(child, enclosing_class.clone(), enclosing_symbol, depth + 1);
                    continue;
                }
                let parent = self.function_parent(child, enclosing_class.clone());
                let Some(name) = self.named_child_text(child) else {
                    self.walk(child, enclosing_class.clone(), enclosing_symbol, depth + 1);
                    continue;
                };
                let index = self.push_symbol(node_kind, name, parent, child);
                self.walk(child, enclosing_class.clone(), Some(index), depth + 1);
            } else if self.tables.imports.contains(&kind) {
                let handled = imports::extract(self.language, child, self.source, &mut self.out);
                // Some grammars share one node type between imports and calls
                // (TS `require`), so an unhandled import falls through.
                if !handled {
                    self.walk(child, enclosing_class.clone(), enclosing_symbol, depth + 1);
                }
            } else if self.tables.calls.contains(&kind) {
                if let Some(callee) = self.callee_of(child)
                    && !imports::extract_call_import(
                        self.language,
                        child,
                        callee,
                        self.source,
                        &mut self.out,
                    )
                {
                    self.push_call(callee, enclosing_symbol, child);
                }
                self.walk(child, enclosing_class.clone(), enclosing_symbol, depth + 1);
            } else {
                self.walk(child, enclosing_class.clone(), enclosing_symbol, depth + 1);
            }
        }
    }

    /// `const f = () => {}` names the function through the declarator; a plain
    /// `const x = 1` must not become a symbol.
    fn is_function_value(&self, node: TsNode<'_>) -> bool {
        node.child_by_field_name("value").is_some_and(|value| {
            matches!(
                value.kind(),
                "arrow_function" | "function_expression" | "function" | "generator_function"
            )
        })
    }

    /// Go methods take their receiver's type as parent, so `(s *Server) Handle`
    /// becomes `Server.Handle` (A1.3).
    fn function_parent(&self, node: TsNode<'_>, enclosing_class: Option<String>) -> Option<String> {
        if self.language == Language::Go
            && node.kind() == "method_declaration"
            && let Some(receiver) = node.child_by_field_name("receiver")
        {
            let text = text_of(receiver, self.source);
            let bare = text
                .trim_matches(|character: char| !character.is_alphanumeric() && character != '_')
                .rsplit([' ', '*'])
                .next()
                .unwrap_or_default();
            if !bare.is_empty() {
                return Some(sanitize(bare));
            }
        }
        enclosing_class
    }

    /// Returns true when the child was fully consumed here.
    fn escape_hatch(
        &mut self,
        child: TsNode<'_>,
        enclosing_class: Option<String>,
        enclosing_symbol: Option<usize>,
        depth: usize,
    ) -> bool {
        match (self.language, child.kind()) {
            (Language::Rust, "impl_item") => {
                self.rust_impl(child, depth);
                true
            }
            (Language::Go, "type_declaration") => {
                self.go_type_declaration(child, depth);
                true
            }
            (Language::CMake, "function_def" | "macro_def") => {
                self.cmake_definition(child, depth);
                true
            }
            (Language::CSharp, "namespace_declaration" | "file_scoped_namespace_declaration") => {
                let previous = self.namespace.clone();
                if let Some(name) = child.child_by_field_name("name") {
                    let name = sanitize(text_of(name, self.source));
                    self.out.namespaces.push(name.clone());
                    self.namespace = Some(name);
                }
                self.walk(child, enclosing_class, enclosing_symbol, depth + 1);
                self.namespace = previous;
                true
            }
            (Language::CMake, "normal_command") => {
                self.cmake_command(child, enclosing_symbol);
                true
            }
            _ => false,
        }
    }

    /// Functions inside an `impl` take the impl target as parent; a trait impl
    /// additionally yields an `implements` relation.
    fn rust_impl(&mut self, node: TsNode<'_>, depth: usize) {
        let target = node
            .child_by_field_name("type")
            .map(|value| sanitize(text_of(value, self.source)));
        if let (Some(target), Some(trait_node)) =
            (target.clone(), node.child_by_field_name("trait"))
        {
            self.out.relations.push(RawRelation {
                relation: "implements".to_owned(),
                from_name: target,
                to_name: sanitize(text_of(trait_node, self.source)),
                line: self.line(node).0,
            });
        }
        self.walk(node, target, None, depth + 1);
    }

    /// Go wraps struct/interface/alias declarations in `type_declaration`; the
    /// interesting names live on the inner `type_spec` nodes.
    fn go_type_declaration(&mut self, node: TsNode<'_>, depth: usize) {
        let mut cursor = node.walk();
        let specs: Vec<TsNode<'_>> = node.children(&mut cursor).collect();
        for spec in specs {
            if spec.kind() != "type_spec" {
                continue;
            }
            let Some(name) = spec.child_by_field_name("name") else {
                continue;
            };
            let kind = match spec.child_by_field_name("type").map(|value| value.kind()) {
                Some("struct_type") => "struct",
                Some("interface_type") => "interface",
                _ => "type",
            };
            let name = sanitize(text_of(name, self.source));
            let index = self.push_symbol(kind, name.clone(), None, spec);
            self.walk(spec, Some(name), Some(index), depth + 1);
        }
    }

    /// CMake names a definition through its opening command's first argument
    /// (`function(helper …)`), not through a `name` field.
    fn cmake_definition(&mut self, node: TsNode<'_>, depth: usize) {
        let mut cursor = node.walk();
        let opening = node
            .children(&mut cursor)
            .find(|child| matches!(child.kind(), "function_command" | "macro_command"));
        let name = opening
            .and_then(|command| self.cmake_arguments(command).into_iter().next())
            .unwrap_or_default();
        if name.is_empty() {
            return;
        }
        let index = self.push_symbol("function", name, None, node);
        self.walk(node, None, Some(index), depth + 1);
    }

    fn cmake_arguments(&self, node: TsNode<'_>) -> Vec<String> {
        let mut cursor = node.walk();
        node.children(&mut cursor)
            .filter(|child| child.kind() == "argument_list")
            .flat_map(|list| {
                let mut inner = list.walk();
                list.named_children(&mut inner)
                    .map(|argument| sanitize(text_of(argument, self.source)))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Everything interesting in CMake is a `normal_command`; dispatch on the
    /// lower-cased command identifier (A1.3).
    fn cmake_command(&mut self, node: TsNode<'_>, enclosing_symbol: Option<usize>) {
        let mut cursor = node.walk();
        let children: Vec<TsNode<'_>> = node.children(&mut cursor).collect();
        let Some(identifier) = children.first() else {
            return;
        };
        let command = text_of(*identifier, self.source).to_ascii_lowercase();
        let arguments = self.cmake_arguments(node);
        let first = arguments.first().cloned().unwrap_or_default();
        let line = self.line(node).0;
        match command.as_str() {
            "add_executable" | "add_library" if !first.is_empty() => {
                self.push_symbol("target", first, None, node);
            }
            "add_subdirectory" | "include" | "find_package" if !first.is_empty() => {
                imports::push_cmake_import(&command, &first, line, &mut self.out);
            }
            "target_link_libraries" if arguments.len() > 1 => {
                for dependency in arguments.iter().skip(1) {
                    if dependency.is_empty() || dependency.starts_with("PUBLIC") {
                        continue;
                    }
                    self.out.relations.push(RawRelation {
                        relation: "depends".to_owned(),
                        from_name: first.clone(),
                        to_name: dependency.clone(),
                        line,
                    });
                }
            }
            _ => {
                self.push_call(*identifier, enclosing_symbol, node);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(language: Language, source: &str) -> FileExtract {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language.grammar()).unwrap();
        let tree = parser.parse(source, None).unwrap();
        extract(language, source.as_bytes(), &tree)
    }

    #[test]
    fn bare_name_takes_the_final_segment() {
        assert_eq!(bare_name("store.save"), "save");
        assert_eq!(bare_name("Store::save"), "save");
        assert_eq!(bare_name("save(a, b)"), "save");
    }

    #[test]
    fn typescript_arrow_constants_become_functions_but_plain_constants_do_not() {
        let extracted = parse(Language::TypeScript, "const f = () => {};\nconst x = 1;\n");
        let names: Vec<&str> = extracted.symbols.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["f"]);
    }

    #[test]
    fn go_methods_take_the_receiver_type_as_parent() {
        let extracted = parse(
            Language::Go,
            "package main\ntype Server struct{}\nfunc (s *Server) Handle() {}\n",
        );
        let method = extracted
            .symbols
            .iter()
            .find(|symbol| symbol.name == "Handle")
            .expect("method extracted");
        assert_eq!(method.parent.as_deref(), Some("Server"));
        assert!(extracted.symbols.iter().any(|s| s.kind == "struct"));
    }

    #[test]
    fn rust_trait_impls_emit_an_implements_relation() {
        let extracted = parse(
            Language::Rust,
            "struct Store;\ntrait Save { fn save(&self); }\nimpl Save for Store { fn save(&self) {} }\n",
        );
        assert!(
            extracted
                .relations
                .iter()
                .any(|relation| relation.relation == "implements"
                    && relation.from_name == "Store"
                    && relation.to_name == "Save")
        );
    }

    #[test]
    fn c_function_names_unwrap_nested_declarators() {
        let extracted = parse(Language::C, "char *build(int n) { return 0; }\n");
        assert_eq!(extracted.symbols[0].name, "build");
    }

    #[test]
    fn cmake_targets_and_links_become_symbols_and_relations() {
        let extracted = parse(
            Language::CMake,
            "add_executable(app main.c)\ntarget_link_libraries(app core)\nadd_subdirectory(lib)\n",
        );
        assert!(
            extracted
                .symbols
                .iter()
                .any(|symbol| symbol.kind == "target" && symbol.name == "app")
        );
        assert!(
            extracted
                .relations
                .iter()
                .any(|relation| relation.relation == "depends" && relation.to_name == "core")
        );
        assert!(!extracted.imports.is_empty());
    }

    #[test]
    fn python_decorated_definitions_are_unwrapped_by_plain_recursion() {
        let extracted = parse(Language::Python, "@app.route\ndef handler():\n    save()\n");
        assert_eq!(extracted.symbols[0].name, "handler");
        assert!(extracted.calls.iter().any(|call| call.name == "save"));
    }

    #[test]
    fn csharp_methods_are_extracted_inside_namespaces() {
        let extracted = parse(
            Language::CSharp,
            "namespace App { class Store { public void Save() { Helper.Run(); } } }",
        );
        assert!(extracted.symbols.iter().any(|s| s.name == "Save"));
        assert!(extracted.calls.iter().any(|call| call.name == "Run"));
    }
}
