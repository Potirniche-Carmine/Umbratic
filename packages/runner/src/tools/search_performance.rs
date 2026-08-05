//! The `search` release performance gate.
//!
//! Two claims are measured against a synthetic workspace of at least 50,000
//! visible paths:
//!
//! 1. A warm path-mode query is at least 3x faster than one that has to rebuild
//!    the index from a cold walk. This is the whole reason the index exists.
//! 2. Literal content search is no more than 20% slower than `grep` over the
//!    same candidate set. The index must not make content search worse.
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
/// Content samples are fewer because each iteration also runs a full cold `grep`
/// over 50,000 files, which dominates the runtime. The measured gap is large
/// enough that a 5-sample median is not the limiting factor.
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
async fn warm_path_search_beats_a_cold_walk_and_content_search_matches_grep() {
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
    // `find`/`grep` do on every single call today.
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

    // Content mode versus grep over the same candidate set and the same needle.
    // The index must not make content search worse than the tool it replaces.
    let mut content = Vec::with_capacity(CONTENT_SAMPLES);
    let mut grep = Vec::with_capacity(CONTENT_SAMPLES);
    for _ in 0..CONTENT_SAMPLES {
        let started = Instant::now();
        let result = search_tool(
            session.clone(),
            json!({"query":"RARE_NEEDLE_TOKEN","mode":"content","path":".","limit":50})
                .as_object()
                .unwrap(),
        )
        .await
        .expect("content search succeeds");
        content.push(started.elapsed());
        assert_eq!(result.status, "success");
        assert!(result.content.contains("RARE_NEEDLE_TOKEN"));

        let started = Instant::now();
        let result = grep_tool(
            &session,
            json!({"pattern":"RARE_NEEDLE_TOKEN","mode":"literal","path":".","limit":50})
                .as_object()
                .unwrap(),
        )
        .await
        .expect("grep succeeds");
        grep.push(started.elapsed());
        assert_eq!(result.status, "success");
    }

    let content_median = median(content);
    let grep_median = median(grep);
    eprintln!(
        "search content mode: {}us, grep: {}us",
        content_median.as_micros(),
        grep_median.as_micros(),
    );
    assert!(
        content_median.as_secs_f64() <= grep_median.as_secs_f64() * 1.2,
        "content search must stay within 20% of grep; \
         search median {content_median:?}, grep median {grep_median:?}"
    );
}
