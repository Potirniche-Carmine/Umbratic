use std::process::ExitCode;

use umbratic_runner::{RUNNER_NAME, RUNNER_VERSION, server};

#[derive(Debug, Default)]
struct Args {
    command: Option<String>,
    hostname: Option<String>,
    port: Option<u16>,
}

fn parse_args() -> Args {
    let mut values = std::env::args().skip(1);
    let mut parsed = Args {
        command: values.next(),
        ..Args::default()
    };
    for item in values {
        let Some((key, value)) = item.split_once('=') else {
            continue;
        };
        match key {
            "--hostname" => parsed.hostname = Some(value.to_owned()),
            "--port" => parsed.port = value.parse().ok(),
            _ => {}
        }
    }
    parsed
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = parse_args();
    if args.command.as_deref() != Some("serve") {
        eprintln!("{RUNNER_NAME} {RUNNER_VERSION}");
        eprintln!("usage: umbratic-runner serve --port=<port>");
        eprintln!("the runner configuration, including the API password, is read from stdin");
        return ExitCode::FAILURE;
    }
    match server::listen(
        &args.hostname.unwrap_or_else(|| "127.0.0.1".to_owned()),
        args.port.unwrap_or(0),
    )
    .await
    {
        Ok(server) => {
            eprintln!("umbratic runner listening on {}", server.url());
            #[cfg(unix)]
            {
                use tokio::signal::unix::{SignalKind, signal};
                if let Ok(mut terminate) = signal(SignalKind::terminate()) {
                    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
                } else {
                    let _ = tokio::signal::ctrl_c().await;
                }
            }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
            server.close().await;
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
