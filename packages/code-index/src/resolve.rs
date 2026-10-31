//! The three-stage evidence funnel (A3). Calls arrive as text; they leave as
//! node ids carrying the tier of evidence that produced them.
//!
//! One deliberate deviation from the design note: an unresolved call is
//! *dropped* rather than emitted as an edge pointing at a bare string. The
//! runner's validator rejects any edge referencing an unknown node — the whole
//! artifact, not just that edge — so a bare-string target would cost the entire
//! graph. Ambiguous calls with candidates keep an edge (to the first candidate
//! by id) labeled `ambiguous`, which is what consumers actually need.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::{
    imports::ImportKind,
    lang::Language,
    model::{Edge, Location, Node, edge_id, file_node_id, sanitize, symbol_node_id},
    tsconfig::{AliasResolver, join_relative, parent_directory},
    walk::FileExtract,
};

pub struct ParsedFile {
    pub path: String,
    pub language: Language,
    pub extract: FileExtract,
}

pub struct Workspace<'a> {
    /// Every indexable path in the workspace, used for import probing.
    pub files: &'a HashSet<String>,
    /// Module path from `go.mod`, when the workspace has one.
    pub go_module: Option<String>,
    /// Reads a workspace-relative file; only tsconfig files are read this way.
    pub read: &'a dyn Fn(&str) -> Option<String>,
}

struct SymbolRecord {
    id: String,
    name: String,
    path: String,
    line: u64,
    is_test: bool,
}

/// TS/JS module specifiers omit the extension; probe the same order the
/// TypeScript resolver uses so the first hit matches what the compiler picks.
fn probe(files: &HashSet<String>, candidate: &str) -> Option<String> {
    if files.contains(candidate) {
        return Some(candidate.to_owned());
    }
    for extension in [
        "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "cs",
    ] {
        let with_extension = format!("{candidate}.{extension}");
        if files.contains(&with_extension) {
            return Some(with_extension);
        }
    }
    for index in [
        "index.ts",
        "index.tsx",
        "index.js",
        "index.jsx",
        "__init__.py",
        "mod.rs",
    ] {
        let nested = format!("{candidate}/{index}");
        if files.contains(&nested) {
            return Some(nested);
        }
    }
    None
}

/// Resolve one import specifier to a workspace file, per the per-language rules
/// in A3 stage 2. `None` means "external" — an honest answer, not a failure.
fn resolve_import(
    workspace: &Workspace<'_>,
    aliases: &mut AliasResolver<'_>,
    importer: &str,
    language: Language,
    specifier: &str,
    kind: ImportKind,
) -> Option<String> {
    let directory = parent_directory(importer);
    match kind {
        ImportKind::External | ImportKind::Namespace => None,
        ImportKind::Subdirectory => {
            let candidate = format!("{}/CMakeLists.txt", join_relative(&directory, specifier));
            workspace.files.contains(&candidate).then_some(candidate)
        }
        ImportKind::Relative => {
            let joined = join_relative(&directory, specifier);
            if language == Language::CMake {
                return probe_cmake(workspace.files, &joined);
            }
            probe(workspace.files, &joined)
        }
        ImportKind::Module => match language {
            Language::TypeScript | Language::Tsx | Language::JavaScript => aliases
                .candidates(importer, specifier)
                .iter()
                .find_map(|candidate| probe(workspace.files, candidate)),
            Language::Python => resolve_python(workspace.files, &directory, specifier),
            Language::Go => resolve_go(workspace, specifier),
            Language::Rust => resolve_rust(workspace.files, &directory, specifier),
            _ => None,
        },
    }
}

fn probe_cmake(files: &HashSet<String>, candidate: &str) -> Option<String> {
    for suffix in ["", ".cmake"] {
        let path = format!("{candidate}{suffix}");
        if files.contains(&path) {
            return Some(path);
        }
    }
    None
}

/// `a.b.c` probed from the importing file's directory upward to the root, which
/// is how Python's own path resolution behaves for workspace-local packages.
fn resolve_python(files: &HashSet<String>, directory: &str, specifier: &str) -> Option<String> {
    let relative = specifier.trim_start_matches('.').replace('.', "/");
    if relative.is_empty() {
        return None;
    }
    let mut prefix = directory.to_owned();
    loop {
        let candidate = if prefix.is_empty() {
            relative.clone()
        } else {
            format!("{prefix}/{relative}")
        };
        if let Some(found) = probe(files, &candidate) {
            return Some(found);
        }
        if prefix.is_empty() {
            return None;
        }
        prefix = parent_directory(&prefix);
    }
}

/// Go imports name packages, not files. The edge targets the package
/// directory's lexicographically first file, which is stable and enough for the
/// import map; call resolution then searches the whole package by name.
fn resolve_go(workspace: &Workspace<'_>, specifier: &str) -> Option<String> {
    let module = workspace.go_module.as_deref()?;
    let remainder = specifier
        .strip_prefix(module)
        .map(|rest| rest.trim_start_matches('/'))?;
    let mut matches: Vec<&String> = workspace
        .files
        .iter()
        .filter(|path| {
            path.ends_with(".go") && parent_directory(path) == remainder.trim_end_matches('/')
        })
        .collect();
    matches.sort();
    matches.first().map(|path| (*path).clone())
}

fn resolve_rust(files: &HashSet<String>, directory: &str, specifier: &str) -> Option<String> {
    let trimmed = specifier
        .trim_start_matches("crate::")
        .trim_start_matches("self::")
        .trim_start_matches("super::");
    let mut segments: Vec<&str> = trimmed
        .split("::")
        .filter(|part| !part.is_empty() && !part.contains(['{', '*', ' ']))
        .collect();
    // `use a::b::thing` names an item inside module `a::b`, so shorten from the
    // right until a module file exists.
    while !segments.is_empty() {
        let relative = segments.join("/");
        for base in [directory, "src", ""] {
            let candidate = if base.is_empty() {
                relative.clone()
            } else {
                format!("{base}/{relative}")
            };
            if let Some(found) = probe(files, &candidate) {
                return Some(found);
            }
        }
        segments.pop();
    }
    None
}

fn module_prefix(path: &str, namespaces: &[String]) -> String {
    if let Some(namespace) = namespaces.first() {
        return namespace.clone();
    }
    let basename = path.rsplit('/').next().unwrap_or(path);
    basename
        .split_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(basename)
        .to_owned()
}

/// Builds every node and edge from the parsed files. This is the whole
/// producer pipeline downstream of parsing.
pub fn resolve(files: &[ParsedFile], workspace: &Workspace<'_>) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut records: Vec<Vec<SymbolRecord>> = Vec::with_capacity(files.len());

    for file in files {
        let is_test = file.language.is_test_path(&file.path);
        let prefix = module_prefix(&file.path, &file.extract.namespaces);
        nodes.push(Node {
            id: file_node_id(&file.path),
            kind: "file".to_owned(),
            label: sanitize(&file.path),
            qualified_name: None,
            location: Some(Location::new(&file.path, 1, 1)),
        });
        let mut file_records = Vec::with_capacity(file.extract.symbols.len());
        for symbol in &file.extract.symbols {
            let id = symbol_node_id(&file.path, &symbol.kind, &symbol.name, symbol.start_line);
            let qualified = match &symbol.parent {
                Some(parent) => format!("{prefix}.{parent}.{}", symbol.name),
                None => format!("{prefix}.{}", symbol.name),
            };
            nodes.push(Node {
                id: id.clone(),
                kind: symbol.kind.clone(),
                label: symbol.name.clone(),
                qualified_name: Some(sanitize(&qualified)),
                location: Some(Location::new(
                    &file.path,
                    symbol.start_line,
                    symbol.end_line,
                )),
            });
            edges.push(Edge {
                id: edge_id(
                    "contains",
                    &file_node_id(&file.path),
                    &id,
                    symbol.start_line,
                ),
                from: file_node_id(&file.path),
                to: id.clone(),
                relation: "contains".to_owned(),
                confidence: "extracted".to_owned(),
                evidence: sanitize(&format!("{} declaration", file.language.name())),
                source: Location::new(&file.path, symbol.start_line, symbol.end_line),
            });
            file_records.push(SymbolRecord {
                id,
                name: symbol.name.clone(),
                path: file.path.clone(),
                line: symbol.start_line,
                is_test,
            });
        }
        records.push(file_records);
    }

    let mut aliases = AliasResolver::new(workspace.read);
    let mut imports_of: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut namespace_files: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut namespace_imports: HashMap<String, BTreeSet<String>> = HashMap::new();

    for file in files {
        for namespace in &file.extract.namespaces {
            namespace_files
                .entry(namespace.clone())
                .or_default()
                .insert(file.path.clone());
        }
        for import in &file.extract.imports {
            if import.kind == ImportKind::Namespace {
                namespace_imports
                    .entry(file.path.clone())
                    .or_default()
                    .insert(import.specifier.clone());
                continue;
            }
            let Some(target) = resolve_import(
                workspace,
                &mut aliases,
                &file.path,
                file.language,
                &import.specifier,
                import.kind,
            ) else {
                continue;
            };
            if target == file.path {
                continue;
            }
            imports_of
                .entry(file.path.clone())
                .or_default()
                .insert(target.clone());
            edges.push(Edge {
                id: edge_id(
                    "imports",
                    &file_node_id(&file.path),
                    &file_node_id(&target),
                    import.line,
                ),
                from: file_node_id(&file.path),
                to: file_node_id(&target),
                relation: "imports".to_owned(),
                confidence: "extracted".to_owned(),
                evidence: sanitize(&format!("import of {}", import.specifier)),
                source: Location::new(&file.path, import.line, import.line),
            });
        }
    }

    // Stage 3 indexes, built once. `BTreeMap`/`BTreeSet` throughout so every
    // iteration that can reach the output is already ordered.
    let mut by_name: BTreeMap<&str, Vec<&SymbolRecord>> = BTreeMap::new();
    for file_records in &records {
        for record in file_records {
            by_name
                .entry(record.name.as_str())
                .or_default()
                .push(record);
        }
    }
    for candidates in by_name.values_mut() {
        candidates.sort_by(|left, right| left.id.cmp(&right.id));
    }

    for (index, file) in files.iter().enumerate() {
        let imported = imports_of.get(&file.path).cloned().unwrap_or_default();
        let namespace_paths: BTreeSet<String> = namespace_imports
            .get(&file.path)
            .into_iter()
            .flatten()
            .filter_map(|namespace| namespace_files.get(namespace))
            .flatten()
            .cloned()
            .collect();
        for call in &file.extract.calls {
            let source_id = call
                .from
                .and_then(|position| records[index].get(position))
                .map(|record| record.id.clone())
                .unwrap_or_else(|| file_node_id(&file.path));
            let all = by_name.get(call.name.as_str()).cloned().unwrap_or_default();

            // Stage 1: a match in the same file is direct evidence.
            let same_file: Vec<&&SymbolRecord> = all
                .iter()
                .filter(|record| record.path == file.path && record.id != source_id)
                .collect();
            let (target, confidence, evidence) = if same_file.len() == 1 {
                (
                    same_file[0].id.clone(),
                    "extracted",
                    format!("call to {} in the same file", call.text),
                )
            } else {
                // Stage 2/3: an imported file, or a `using`d namespace for C#.
                let reachable: Vec<&&SymbolRecord> = all
                    .iter()
                    .filter(|record| {
                        imported.contains(&record.path) || namespace_paths.contains(&record.path)
                    })
                    .collect();
                match reachable.len() {
                    1 => (
                        reachable[0].id.clone(),
                        "inferred",
                        format!("resolved through import of {}", reachable[0].path),
                    ),
                    0 => continue,
                    count => {
                        let listed: Vec<&str> = reachable
                            .iter()
                            .take(5)
                            .map(|record| record.path.as_str())
                            .collect();
                        (
                            reachable[0].id.clone(),
                            "ambiguous",
                            format!("{count} candidates: {}", listed.join(", ")),
                        )
                    }
                }
            };
            if target == source_id {
                continue;
            }
            edges.push(Edge {
                id: edge_id("calls", &source_id, &target, call.line),
                from: source_id.clone(),
                to: target.clone(),
                relation: "calls".to_owned(),
                confidence: confidence.to_owned(),
                evidence: sanitize(&evidence),
                source: Location::new(&file.path, call.line, call.line),
            });
            // A4: mirrored production→test, so "what tests cover X" is one
            // outgoing-edge lookup on X.
            if records[index]
                .get(call.from.unwrap_or(usize::MAX))
                .is_some_and(|record| record.is_test)
            {
                edges.push(Edge {
                    id: edge_id("tested_by", &target, &source_id, call.line),
                    from: target,
                    to: source_id,
                    relation: "tested_by".to_owned(),
                    confidence: confidence.to_owned(),
                    evidence: "mirrored from test call site".to_owned(),
                    source: Location::new(&file.path, call.line, call.line),
                });
            }
        }

        for relation in &file.extract.relations {
            let find = |name: &str| {
                by_name
                    .get(name)
                    .and_then(|candidates| candidates.first())
                    .map(|record| (record.id.clone(), record.path.clone(), record.line))
            };
            let (Some((from, _, _)), Some((to, path, _))) =
                (find(&relation.from_name), find(&relation.to_name))
            else {
                continue;
            };
            if from == to {
                continue;
            }
            edges.push(Edge {
                id: edge_id(&relation.relation, &from, &to, relation.line),
                from,
                to,
                relation: relation.relation.clone(),
                confidence: "extracted".to_owned(),
                evidence: sanitize(&format!("declared against {path}")),
                source: Location::new(&file.path, relation.line, relation.line),
            });
        }
    }

    (nodes, edges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walk;

    fn parse(path: &str, source: &str) -> ParsedFile {
        let language = Language::from_path(path).expect("known language");
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language.grammar()).unwrap();
        let tree = parser.parse(source, None).unwrap();
        ParsedFile {
            path: path.to_owned(),
            language,
            extract: walk::extract(language, source.as_bytes(), &tree),
        }
    }

    fn resolve_all(files: &[ParsedFile]) -> (Vec<Node>, Vec<Edge>) {
        let paths: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();
        let read = |_: &str| None;
        resolve(
            files,
            &Workspace {
                files: &paths,
                go_module: None,
                read: &read,
            },
        )
    }

    #[test]
    fn cross_file_calls_resolve_through_imports_as_inferred() {
        let files = [
            parse("src/store.ts", "export function save() {}\n"),
            parse(
                "src/service.ts",
                "import { save } from './store';\nexport function createUser() { save(); }\n",
            ),
        ];
        let (_, edges) = resolve_all(&files);
        let call = edges
            .iter()
            .find(|edge| edge.relation == "calls")
            .expect("call edge");
        assert_eq!(call.confidence, "inferred");
        assert!(call.to.contains("src/store.ts"));
        assert!(edges.iter().any(|edge| edge.relation == "imports"));
    }

    #[test]
    fn a_globally_unique_name_alone_is_not_evidence() {
        let files = [
            parse("src/store.ts", "export function save() {}\n"),
            parse("src/other.ts", "export function run() { save(); }\n"),
        ];
        let (_, edges) = resolve_all(&files);
        assert!(!edges.iter().any(|edge| edge.relation == "calls"));
    }

    #[test]
    fn same_file_calls_are_extracted_confidence() {
        let files = [parse(
            "src/a.py",
            "def save():\n    pass\n\ndef run():\n    save()\n",
        )];
        let (_, edges) = resolve_all(&files);
        let call = edges
            .iter()
            .find(|edge| edge.relation == "calls")
            .expect("call edge");
        assert_eq!(call.confidence, "extracted");
    }

    #[test]
    fn test_files_mirror_calls_into_tested_by_edges() {
        let files = [
            parse("src/store.ts", "export function save() {}\n"),
            parse(
                "src/store.test.ts",
                "import { save } from './store';\nexport function itSaves() { save(); }\n",
            ),
        ];
        let (_, edges) = resolve_all(&files);
        let mirrored = edges
            .iter()
            .find(|edge| edge.relation == "tested_by")
            .expect("tested_by edge");
        assert!(mirrored.from.contains("src/store.ts"));
        assert!(mirrored.to.contains("src/store.test.ts"));
    }

    #[test]
    fn contains_edges_and_qualified_names_are_emitted_per_symbol() {
        let files = [parse(
            "src/store.ts",
            "export class Store {\n  save() {}\n}\n",
        )];
        let (nodes, edges) = resolve_all(&files);
        let method = nodes
            .iter()
            .find(|node| node.label == "save")
            .expect("method node");
        assert_eq!(method.qualified_name.as_deref(), Some("store.Store.save"));
        assert_eq!(
            edges
                .iter()
                .filter(|edge| edge.relation == "contains")
                .count(),
            2
        );
    }
}
