use anyhow::{Context, Result, bail};
use centaur_session_core::ThreadKey;
use clap::Parser;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use uuid::Uuid;

const DEFAULT_MESSAGE: &str = "Reply with exactly PONG and nothing else.";

#[derive(Debug, Parser)]
#[command(about = "Create, execute, or attach to a Centaur session")]
struct Args {
    #[arg(long, env = "CENTAUR_API_URL", default_value = "http://127.0.0.1:8080")]
    api_url: String,

    #[arg(long)]
    thread_key: Option<String>,

    #[arg(long)]
    attach: bool,

    #[arg(long, default_value = "codex")]
    harness_type: String,

    #[arg(long)]
    message: Option<String>,

    #[arg(long = "input-line")]
    input_lines: Vec<String>,

    #[arg(long, default_value_t = 1_000)]
    idle_timeout_ms: u64,

    #[arg(long, default_value_t = 60_000)]
    max_duration_ms: u64,

    #[arg(long, default_value_t = 0)]
    after_event_id: i64,

    #[arg(long)]
    all_events: bool,

    #[arg(long)]
    exit_on_terminal: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let attach_mode = attach_mode(&args);
    validate_mode(&args, attach_mode)?;
    let (thread_key, generated_thread_key) = thread_key_arg(&args, attach_mode)?;
    let thread_key = ThreadKey::parse(thread_key)?;
    if generated_thread_key {
        eprintln!("thread_key={}", thread_key.as_str());
    }
    let client = Client::new();
    let base_url = args.api_url.trim_end_matches('/').to_owned();
    let session_url = session_url(&base_url, thread_key.as_str());

    if attach_mode {
        let events_response = open_event_stream(&client, &session_url, args.after_event_id).await?;
        return stream_output_lines(events_response, args.all_events, args.exit_on_terminal).await;
    }

    let input_lines = session_input_lines(&args)?;
    let message = message_text(&args);

    post_json(
        &client,
        &session_url,
        json!({
            "harness_type": args.harness_type,
            "metadata": {
                "source": "centaur-session-cli",
            },
        }),
    )
    .await
    .context("create session")?;

    post_json(
        &client,
        &format!("{session_url}/messages"),
        json!({
            "messages": [{
                "role": "user",
                "parts": [{"type": "text", "text": message}],
                "metadata": {
                    "source": "centaur-session-cli",
                },
            }],
        }),
    )
    .await
    .context("append message")?;

    let events_response = open_event_stream(&client, &session_url, args.after_event_id).await?;

    let mut execute_task = spawn_execute(
        client.clone(),
        format!("{session_url}/execute"),
        input_lines,
        args.idle_timeout_ms,
        args.max_duration_ms,
    );

    let stream_future =
        stream_output_lines(events_response, args.all_events, args.exit_on_terminal);
    tokio::pin!(stream_future);

    tokio::select! {
        stream_result = &mut stream_future => {
            execute_task.await.context("join execute task")??;
            stream_result
        }
        execute_result = &mut execute_task => {
            execute_result.context("join execute task")??;
            stream_future.await
        }
    }
}

fn attach_mode(args: &Args) -> bool {
    args.attach
        || (args.after_event_id > 0
            && args.thread_key.is_some()
            && args.message.is_none()
            && args.input_lines.is_empty())
}

fn validate_mode(args: &Args, attach_mode: bool) -> Result<()> {
    if attach_mode && args.thread_key.is_none() {
        bail!("attach mode requires --thread-key");
    }
    if args.attach && (args.message.is_some() || !args.input_lines.is_empty()) {
        bail!("--attach does not accept --message or --input-line");
    }
    Ok(())
}

fn thread_key_arg(args: &Args, attach_mode: bool) -> Result<(String, bool)> {
    match (&args.thread_key, attach_mode) {
        (Some(thread_key), _) => Ok((thread_key.clone(), false)),
        (None, true) => bail!("--attach requires --thread-key"),
        (None, false) => Ok((format!("cli:{}", Uuid::new_v4().simple()), true)),
    }
}

async fn post_json(client: &Client, url: &str, payload: Value) -> Result<Value> {
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    let status = response.status();
    let body = response.text().await?;
    ensure_success(status, body.clone()).with_context(|| format!("POST {url}"))?;
    serde_json::from_str(&body).with_context(|| format!("decode response from {url}"))
}

fn ensure_success(status: reqwest::StatusCode, body: String) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    bail!("HTTP {status}: {body}");
}

async fn ensure_response_success(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await?;
    bail!("HTTP {status}: {body}");
}

async fn open_event_stream(
    client: &Client,
    session_url: &str,
    after_event_id: i64,
) -> Result<reqwest::Response> {
    let events_url = format!("{session_url}/events?after_event_id={after_event_id}");
    let events_response = client
        .get(&events_url)
        .send()
        .await
        .context("open event stream")?;
    ensure_response_success(events_response)
        .await
        .context("open event stream")
}

fn spawn_execute(
    client: Client,
    url: String,
    input_lines: Vec<String>,
    idle_timeout_ms: u64,
    max_duration_ms: u64,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        post_json(
            &client,
            &url,
            json!({
                "metadata": {
                    "source": "centaur-session-cli",
                },
                "input_lines": input_lines,
                "idle_timeout_ms": idle_timeout_ms,
                "max_duration_ms": max_duration_ms,
            }),
        )
        .await
        .context("execute session")?;
        Ok(())
    })
}

async fn stream_output_lines(
    response: reqwest::Response,
    all_events: bool,
    exit_on_terminal: bool,
) -> Result<()> {
    let mut chunks = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.context("read event stream")?;
        buffer.push_str(std::str::from_utf8(&chunk).context("event stream is not UTF-8")?);

        while let Some((frame_end, separator_len)) = next_frame(&buffer) {
            let frame = buffer[..frame_end].to_owned();
            buffer.drain(..frame_end + separator_len);

            let Some(event) = SseFrame::parse(&frame) else {
                continue;
            };

            if event.event == "session.output.line" {
                println!(
                    "{}\t{}",
                    event.id.as_deref().unwrap_or("unknown"),
                    event.data
                );
            } else if all_events {
                let data = parse_json_or_string(&event.data);
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "sse_event": event.event,
                        "id": event.id,
                        "data": data,
                    }))?
                );
            }

            if exit_on_terminal && is_terminal_event(&event.event) {
                return Ok(());
            }
        }
    }

    Ok(())
}

fn session_input_lines(args: &Args) -> Result<Vec<String>> {
    if !args.input_lines.is_empty() {
        return Ok(args.input_lines.clone());
    }
    let message = message_text(args);
    Ok(vec![serde_json::to_string(&json!({
        "type": "user",
        "message": {
            "content": [{"type": "text", "text": message}],
        },
    }))?])
}

fn message_text(args: &Args) -> &str {
    args.message.as_deref().unwrap_or(DEFAULT_MESSAGE)
}

fn session_url(base_url: &str, thread_key: &str) -> String {
    format!("{base_url}/api/session/{}", urlencoding::encode(thread_key))
}

fn next_frame(buffer: &str) -> Option<(usize, usize)> {
    let lf = buffer.find("\n\n").map(|index| (index, 2));
    let crlf = buffer.find("\r\n\r\n").map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(frame), None) | (None, Some(frame)) => Some(frame),
        (None, None) => None,
    }
}

fn parse_json_or_string(data: &str) -> Value {
    serde_json::from_str(data).unwrap_or_else(|_| Value::String(data.to_owned()))
}

fn is_terminal_event(event: &str) -> bool {
    matches!(
        event,
        "session.execution_completed" | "session.execution_failed" | "session.execution_cancelled"
    )
}

#[derive(Debug)]
struct SseFrame {
    id: Option<String>,
    event: String,
    data: String,
}

impl SseFrame {
    fn parse(frame: &str) -> Option<Self> {
        let frame = frame.replace("\r\n", "\n");
        let mut id = None;
        let mut event = "message".to_owned();
        let mut data = Vec::new();

        for line in frame.lines() {
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("id:") {
                id = Some(value.trim_start().to_owned());
            } else if let Some(value) = line.strip_prefix("event:") {
                event = value.trim_start().to_owned();
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim_start().to_owned());
            }
        }

        if data.is_empty() {
            return None;
        }

        Some(Self {
            id,
            event,
            data: data.join("\n"),
        })
    }
}
