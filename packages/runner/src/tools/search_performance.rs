//! The `search` release performance gate.
//!
//! Three claims are measured against a synthetic workspace of at least 50,000
//! visible paths:
//!
//! 1. A warm path-mode query is at least 3x faster than one that has to rebuild
//!    the index from a cold walk. This is the whole reason the index exists.
//! 2. A warm content query is at least 2x faster than a cold one, so the index
//!    earns its keep for content scanning and not only for path ranking.
//! 3. Regex mode stays in the same order of magnitude as literal mode over the
//!    same candidate set, so absorbing the old `grep` did not add a slow path.
//!
//! First-build time and index memory are reported separately rather than folded
//! into the warm number, so a warm win bought with an unacceptable build cost is
//! visible instead of hidden.

use std::time::{Duration, Instant};

use super::*;

/// The plan's floor. Kept as a named constant so the gate cannot be weakened by
/// quietly shrinking the fixture.
const MIN_FIXTURE_PATHS: usize = 50_000;
const PACKAGES: usize = 50;
const MODULES_PER_PACKAGE: usize = 20;
const FILES_PER_MODULE: usize = 50;
/// Path-mode samples. Cheap enough to take a real median.
const PATH_SAMPLES: usize = 9;
/// Content samples are fewer because each cold iteration rebuilds the index over
/// 50,000 files, which dominates the runtime. The measured gap is large enough
/// that a 5-sample median is not the limiting factor.
const CONTENT_SAMPLES: usize = 5;

fn median(mut values: Vec<Duration>) -> Duration {
    values.sort_unstable();
    values[values.len() / 2]
}

/// Builds a deterministic workspace. The tree is generated rather than checked
/// in: 50,000 committed files would dominate the repository, and the generator
/// is the reproducible artifact.
///
/// One file per module carries the rare needle so content search has real work
/// to do without every file matching.
fn build_fixture(root: &std::path::Path) -> usize {
    let mut created = 0;
    for package in 0..PACKAGES {
        for module in 0..MODULES_PER_PACKAGE {
            let directory = root.join(format!("pkg{package:02}/mod{module:02}"));
            fs::create_dir_all(&directory).expect("fixture directory");
            for file in 0..FILES_PER_MODULE {
                let body = if file == 0 {
                    "fn handler() {}\nconst RARE_NEEDLE_TOKEN: u32 = 1;\n"
                } else {
                    "fn handler() {}\nconst ORDINARY: u32 = 0;\n"
                };
                fs::write(directory.join(format!("file{file:02}.rs")), body).expect("fixture file");
                created += 1;
            }
        }
    }
    created
}

async fn path_search(session: &Arc<Session>) -> ToolResult {
    search_tool(
        session.clone(),
        json!({"query":"file07","mode":"path","path":".","limit":50})
            .as_object()
            .unwrap(),
    )
    .await
    .expect("path search succeeds")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_warm_index_speeds_up_both_search_modes_and_regex_keeps_pace() {
    let directory = tempfile::tempdir().unwrap();
    let created = build_fixture(directory.path());
    assert!(
        created >= MIN_FIXTURE_PATHS,
        "fixture must hold at least {MIN_FIXTURE_PATHS} paths, built {created}"
    );
    let session = crate::session::test_session(directory.path());

    // First build, measured on its own. It is a real cost paid once per run.
    let started = Instant::now();
    let first = path_search(&session).await;
    let first_build = started.elapsed();
    assert_eq!(first.status, "success");

    let (indexed, index_bytes) = session.search_index.footprint();
    assert!(
        indexed >= MIN_FIXTURE_PATHS,
        "index holds {indexed} entries, expected at least {MIN_FIXTURE_PATHS}"
    );

    // Warm: the index is current, so each query is a scan of memory.
    let mut warm = Vec::with_capacity(PATH_SAMPLES);
    for _ in 0..PATH_SAMPLES {
        let started = Instant::now();
        let result = path_search(&session).await;
        warm.push(started.elapsed());
        assert_eq!(result.status, "success");
    }

    // Cold: invalidate first, so each query pays for a full walk. This is what
    // `find` does on every single call today.
    let mut cold = Vec::with_capacity(PATH_SAMPLES);
    for _ in 0..PATH_SAMPLES {
        session.search_index.mark_stale();
        let started = Instant::now();
        let result = path_search(&session).await;
        cold.push(started.elapsed());
        assert_eq!(result.status, "success");
    }

    let warm_median = median(warm);
    let cold_median = median(cold);
    eprintln!(
        "search path mode: warm median {}us, cold median {}us, first build {}ms, \
         index {indexed} entries / {} KiB",
        warm_median.as_micros(),
        cold_median.as_micros(),
        first_build.as_millis(),
        index_bytes / 1024,
    );
    assert!(
        warm_median * 3 <= cold_median,
        "warm path search must be at least 3x faster than a cold walk; \
         warm median {warm_median:?}, cold median {cold_median:?}"
    );

    // Content mode, warm against cold. The index is what removes the walk from
    // every query after the first.
    let content_query = |mode: &'static str, query: &'static str| {
        let session = session.clone();
        async move {
            search_tool(
                session,
                json!({"query": query, "mode": mode, "path": ".", "limit": 50})
                    .as_object()
                    .unwrap(),
            )
            .await
            .expect("content search succeeds")
        }
    };

    let mut warm_content = Vec::with_capacity(CONTENT_SAMPLES);
    let mut cold_content = Vec::with_capacity(CONTENT_SAMPLES);
    let mut regex_content = Vec::with_capacity(CONTENT_SAMPLES);
    for _ in 0..CONTENT_SAMPLES {
        let started = Instant::now();
        let result = content_query("content", "RARE_NEEDLE_TOKEN").await;
        warm_content.push(started.elapsed());
        assert!(result.content.contains("RARE_NEEDLE_TOKEN"));

        // The same needle as a pattern, so the two modes do identical work apart
        // from how each line is tested.
        let started = Instant::now();
        let result = content_query("regex", r"RARE_\w+_TOKEN").await;
        regex_content.push(started.elapsed());
        assert!(result.content.contains("RARE_NEEDLE_TOKEN"));

        session.search_index.mark_stale();
        let started = Instant::now();
        let result = content_query("content", "RARE_NEEDLE_TOKEN").await;
        cold_content.push(started.elapsed());
        assert!(result.content.contains("RARE_NEEDLE_TOKEN"));
    }

    let warm_content_median = median(warm_content);
    let cold_content_median = median(cold_content);
    let regex_median = median(regex_content);
    eprintln!(
        "search content mode: warm {}us, cold {}us, regex {}us",
        warm_content_median.as_micros(),
        cold_content_median.as_micros(),
        regex_median.as_micros(),
    );
    assert!(
        warm_content_median * 2 <= cold_content_median,
        "a warm content search must be at least 2x faster than a cold one; \
         warm {warm_content_median:?}, cold {cold_content_median:?}"
    );
    assert!(
        regex_median.as_secs_f64() <= warm_content_median.as_secs_f64() * 4.0,
        "regex mode must stay in the same order as literal mode; \
         regex {regex_median:?}, literal {warm_content_median:?}"
    );
}
