use std::{
    path::Path,
    time::{Duration, Instant},
};

use serde_json::json;
use umbratic_runner::{
    context::{ContextEstimateInput, estimate_context_usage, request_profile_fingerprint},
    safety::evaluate_command,
};

fn p95(mut values: Vec<Duration>) -> Duration {
    values.sort_unstable();
    values[(values.len() * 95 / 100).min(values.len() - 1)]
}

#[test]
fn maximum_active_view_planning_meets_the_release_p95_gate() {
    let messages = (0..60)
        .map(|index| json!({"role":if index % 2 == 0 { "user" } else { "assistant" },"content":format!("message {index} {}", "context ".repeat(300))}))
        .collect::<Vec<_>>();
    let tools = (0..12)
        .map(|index| json!({"type":"function","function":{"name":format!("tool_{index}"),"description":"bounded tool schema","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}))
        .collect::<Vec<_>>();
    let skills = (0..32)
        .map(|index| json!({"id":format!("skill-{index}"),"name":format!("Skill {index}"),"description":"bounded skill metadata","source":"system"}))
        .collect::<Vec<_>>();
    let mut samples = Vec::with_capacity(500);
    for _ in 0..500 {
        let started = Instant::now();
        let usage = estimate_context_usage(ContextEstimateInput {
            messages: &messages,
            tools: &tools,
            skills: &skills,
            context_length: 64_000,
            max_response_tokens: 8_192,
            protected_prompt_reserve_tokens: 2_048,
            system_prompt: None,
            anchor: None,
        });
        let fingerprint = request_profile_fingerprint(
            "model",
            "/api/engineering/chat",
            64_000,
            2_048,
            &tools,
            &skills,
        );
        assert!(usage.heuristic_prompt_tokens > 0 && !fingerprint.is_empty());
        samples.push(started.elapsed());
    }
    let measured = p95(samples);
    eprintln!("context planning p95: {}us", measured.as_micros());
    let limit = if cfg!(debug_assertions) {
        Duration::from_millis(5)
    } else {
        Duration::from_millis(1)
    };
    assert!(
        measured < limit,
        "context planning p95 was {measured:?}; limit {limit:?}"
    );
}

#[test]
fn command_safety_evaluation_stays_below_one_millisecond_p95() {
    let commands = [
        "git status --short",
        "npm run test:all",
        "git status; curl https://example.com",
        "python scripts/check.py",
        "rm -rf build/output",
        "echo $(generated)",
    ];
    for command in commands {
        let _ = evaluate_command(command, Path::new("/workspace"));
    }
    let mut samples = Vec::with_capacity(1_000);
    for index in 0..1_000 {
        let started = Instant::now();
        let _ = evaluate_command(commands[index % commands.len()], Path::new("/workspace"));
        samples.push(started.elapsed());
    }
    let measured = p95(samples);
    eprintln!("command safety p95: {}us", measured.as_micros());
    assert!(
        measured < Duration::from_millis(1),
        "command safety p95 was {measured:?}"
    );
}
