#!/usr/bin/env python3
"""Centaur NDJSON bridge for the opencode CLI.

opencode exposes a headless HTTP server (``opencode serve``) with an OpenAPI
surface and a global Server-Sent-Events stream, rather than a stdin/stdout
app-server like codex. This wrapper spans that gap so opencode speaks the same
NDJSON dialect Centaur already consumes from the codex/claude wrappers:

* It boots ``opencode serve`` bound to loopback, waits for readiness, and opens
  one persistent session.
* Centaur's Anthropic-shaped envelopes (``{"type":"user","message":{...}}``
  plus ``interrupt``) arrive on stdin. Each user turn is delivered with a
  **synchronous** ``POST /session/:id/message`` whose response carries the
  finished assistant message — that return is the authoritative end-of-turn
  signal, so there is no ambiguity about which ``session.idle`` belongs to us.
* The global ``GET /event`` stream is used only for live streaming: text and
  reasoning deltas for our session are re-emitted as Anthropic ``stream_event``
  deltas and tool calls as ``content_block_start`` blocks, exactly the shapes
  the claude/amp normalizer already understands.
* ``SIGUSR1`` and ``{"type":"interrupt"}`` abort the active turn via
  ``POST /session/:id/abort``.

The emitted events deliberately mirror the claude-code wire format so the API
control plane can treat the ``opencode`` engine as claude-like (see
``api/sandbox/harness_protocol.py`` and ``api/sandbox/normalize.py``). The
model and provider are configured entirely through ``opencode.json`` /
``OPENCODE_CONFIG_CONTENT`` written by the entrypoint, so no per-message model
override is sent here.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_PORT = 4096
SERVER_READY_TIMEOUT_S = 60.0
# Watchdog for a single turn's synchronous message POST. opencode turns can run
# for many minutes (large refactors, deep tool loops); this is a generous
# ceiling, not a quality budget.
TURN_TIMEOUT_S = float(os.environ.get("OPENCODE_TURN_TIMEOUT_SECONDS") or 1800)

SERVER: subprocess.Popen[str] | None = None
SESSION_ID: str = ""
SHUTTING_DOWN = False
TURN_LOCK = threading.Lock()
TURN_ACTIVE = threading.Event()
# User turns are queued by the stdin reader; interrupts are dispatched inline by
# that thread so they cancel a turn that is blocked on its synchronous POST.
USER_TURNS: queue.Queue[dict[str, Any] | None] = queue.Queue()

# Tracks how much of each streamed text/reasoning part has already been emitted,
# so we forward only the new suffix when opencode reports cumulative text.
_PART_EMITTED_LEN: dict[str, int] = {}
_TOOL_STARTED: set[str] = set()
_STREAM_LOCK = threading.Lock()


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    )
    sys.stdout.flush()


# ── HTTP helpers (stdlib only — the sandbox has no `requests`) ────────────────


def _base_url() -> str:
    port = int(os.environ.get("OPENCODE_SERVER_PORT") or DEFAULT_PORT)
    return f"http://127.0.0.1:{port}"


def _auth_header() -> dict[str, str]:
    password = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if not password:
        return {}
    username = os.environ.get("OPENCODE_SERVER_USERNAME") or "opencode"
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float,
) -> Any:
    url = f"{_base_url()}{path}"
    data = (
        json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    )
    headers = {"Accept": "application/json", **_auth_header()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    # The local server must never be reached through the egress proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _wait_for_server() -> None:
    deadline = time.monotonic() + SERVER_READY_TIMEOUT_S
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        if SERVER is not None and SERVER.poll() is not None:
            raise RuntimeError(
                f"opencode serve exited early with code {SERVER.returncode}"
            )
        try:
            _request("GET", "/global/health", timeout=3.0)
            return
        except (urllib.error.URLError, OSError, socket.timeout) as exc:
            last_err = exc
            time.sleep(0.25)
    raise RuntimeError(f"opencode server not ready in {SERVER_READY_TIMEOUT_S}s: {last_err}")


def _create_or_resume_session() -> str:
    resume = (os.environ.get("OPENCODE_CONTINUE_SESSION_ID") or "").strip()
    if resume:
        try:
            session = _request("GET", f"/session/{resume}", timeout=10.0)
            if isinstance(session, dict) and session.get("id"):
                return str(session["id"])
        except (urllib.error.URLError, OSError, socket.timeout):
            pass  # fall through to a fresh session
    session = _request("POST", "/session", body={}, timeout=30.0)
    if not isinstance(session, dict) or not session.get("id"):
        raise RuntimeError(f"unexpected /session response: {session!r}")
    return str(session["id"])


# ── SSE event stream → Anthropic-shaped streaming deltas ──────────────────────


def _emit_text_delta(part: dict[str, Any], delta: str | None) -> None:
    part_id = str(part.get("id") or "")
    text = part.get("text")
    if not isinstance(text, str):
        return
    chunk = delta if isinstance(delta, str) and delta else ""
    if not chunk:
        with _STREAM_LOCK:
            seen = _PART_EMITTED_LEN.get(part_id, 0)
            if len(text) <= seen:
                return
            chunk = text[seen:]
            _PART_EMITTED_LEN[part_id] = len(text)
    else:
        with _STREAM_LOCK:
            _PART_EMITTED_LEN[part_id] = len(text)
    if not chunk:
        return
    emit(
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": chunk},
            },
        }
    )


def _emit_reasoning_delta(part: dict[str, Any], delta: str | None) -> None:
    part_id = f"reasoning:{part.get('id') or ''}"
    text = part.get("text")
    if not isinstance(text, str):
        return
    chunk = delta if isinstance(delta, str) and delta else ""
    if not chunk:
        with _STREAM_LOCK:
            seen = _PART_EMITTED_LEN.get(part_id, 0)
            if len(text) <= seen:
                return
            chunk = text[seen:]
            _PART_EMITTED_LEN[part_id] = len(text)
    else:
        with _STREAM_LOCK:
            _PART_EMITTED_LEN[part_id] = len(text)
    if not chunk:
        return
    emit(
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {"type": "thinking_delta", "thinking": chunk},
            },
        }
    )


def _emit_tool_start(part: dict[str, Any]) -> None:
    call_id = str(part.get("callID") or part.get("id") or "")
    if not call_id:
        return
    with _STREAM_LOCK:
        if call_id in _TOOL_STARTED:
            return
        _TOOL_STARTED.add(call_id)
    state = part.get("state") if isinstance(part.get("state"), dict) else {}
    tool_input = state.get("input") if isinstance(state.get("input"), dict) else {}
    emit(
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "content_block": {
                    "type": "tool_use",
                    "id": call_id,
                    "name": str(part.get("tool") or "tool"),
                    "input": tool_input,
                },
            },
        }
    )


def _handle_stream_event(event: dict[str, Any]) -> None:
    etype = event.get("type")
    props = event.get("properties") if isinstance(event.get("properties"), dict) else {}
    if etype == "message.part.updated":
        part = props.get("part") if isinstance(props.get("part"), dict) else {}
        if part.get("sessionID") != SESSION_ID:
            return  # subagent / unrelated session
        ptype = part.get("type")
        if ptype == "text":
            _emit_text_delta(part, props.get("delta"))
        elif ptype == "reasoning":
            _emit_reasoning_delta(part, props.get("delta"))
        elif ptype == "tool":
            _emit_tool_start(part)
    elif etype == "session.error" and props.get("sessionID") in (SESSION_ID, None):
        err = props.get("error")
        message = _error_message(err)
        if message:
            emit({"type": "error", "message": message})


def _sse_reader() -> None:
    """Stream the global event bus, forwarding our session's deltas."""
    backoff = 0.5
    while not SHUTTING_DOWN:
        try:
            req = urllib.request.Request(
                f"{_base_url()}/event",
                headers={"Accept": "text/event-stream", **_auth_header()},
                method="GET",
            )
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=None) as resp:
                backoff = 0.5
                for raw in resp:
                    if SHUTTING_DOWN:
                        return
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:") :].strip()
                    if not payload:
                        continue
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(event, dict):
                        try:
                            _handle_stream_event(event)
                        except Exception as exc:  # never let streaming kill the turn
                            emit({"type": "system", "subtype": "stream_error", "message": str(exc)})
        except (urllib.error.URLError, OSError, socket.timeout):
            if SHUTTING_DOWN:
                return
            time.sleep(backoff)
            backoff = min(backoff * 2, 5.0)


# ── Turn handling ─────────────────────────────────────────────────────────────


def _error_message(err: Any) -> str:
    if isinstance(err, str):
        return err
    if isinstance(err, dict):
        data = err.get("data") if isinstance(err.get("data"), dict) else {}
        return (
            str(data.get("message"))
            if data.get("message")
            else str(err.get("name") or err.get("message") or "opencode error")
        )
    return ""


def _final_text_from_message(response: Any) -> str:
    """Pull the assistant text from a /session/:id/message response."""
    if not isinstance(response, dict):
        return ""
    parts = response.get("parts")
    if not isinstance(parts, list):
        return ""
    texts = [
        p.get("text", "")
        for p in parts
        if isinstance(p, dict) and p.get("type") == "text" and p.get("text")
    ]
    return texts[-1] if texts else ""


def _content_to_text(blocks: list[Any]) -> str:
    out: list[str] = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                out.append(text)
    return "\n".join(t for t in out if t).strip()


def handle_user_turn(turn_input: dict[str, Any]) -> None:
    message = turn_input.get("message")
    if not isinstance(message, dict):
        return
    blocks = message.get("content")
    if not isinstance(blocks, list) or not blocks:
        return
    text = _content_to_text(blocks)
    if not text:
        return

    with TURN_LOCK:
        TURN_ACTIVE.set()
        with _STREAM_LOCK:
            _PART_EMITTED_LEN.clear()
            _TOOL_STARTED.clear()
        try:
            response = _request(
                "POST",
                f"/session/{SESSION_ID}/message",
                body={"parts": [{"type": "text", "text": text}]},
                timeout=TURN_TIMEOUT_S,
            )
            result_text = _final_text_from_message(response)
            emit(
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": result_text,
                }
            )
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:1000] if exc.fp else ""
            _emit_turn_error(f"opencode HTTP {exc.code}: {detail or exc.reason}")
        except (urllib.error.URLError, OSError, socket.timeout) as exc:
            _emit_turn_error(f"opencode request failed: {exc}")
        finally:
            TURN_ACTIVE.clear()


def _emit_turn_error(message: str) -> None:
    emit({"type": "error", "message": message})
    emit(
        {
            "type": "result",
            "subtype": "error",
            "is_error": True,
            "result": message,
        }
    )


def interrupt_active_turn(*_args: object) -> None:
    if not TURN_ACTIVE.is_set() or not SESSION_ID:
        return
    try:
        _request("POST", f"/session/{SESSION_ID}/abort", body={}, timeout=10.0)
    except (urllib.error.URLError, OSError, socket.timeout) as exc:
        emit({"type": "error", "message": f"interrupt failed: {exc}"})


# ── Process lifecycle ─────────────────────────────────────────────────────────


def _build_serve_cmd() -> list[str]:
    port = int(os.environ.get("OPENCODE_SERVER_PORT") or DEFAULT_PORT)
    return ["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(port)]


def exit_wrapper(*_args: object) -> None:
    global SHUTTING_DOWN
    SHUTTING_DOWN = True
    if SERVER and SERVER.poll() is None:
        try:
            os.killpg(os.getpgid(SERVER.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


def _stdin_reader() -> None:
    """Read Centaur envelopes off stdin.

    Interrupts are dispatched here so they cancel a turn that is currently
    blocked on its synchronous message POST; user turns are queued for the main
    thread to run one at a time.
    """
    for raw in sys.stdin:
        if SHUTTING_DOWN:
            break
        line = raw.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            emit({"type": "error", "message": "invalid stdin JSON"})
            continue
        if not isinstance(item, dict):
            continue
        if item.get("type") == "interrupt":
            interrupt_active_turn()
        elif item.get("type") == "user":
            USER_TURNS.put(item)
    USER_TURNS.put(None)


def main() -> None:
    global SERVER, SESSION_ID
    signal.signal(signal.SIGTERM, exit_wrapper)
    signal.signal(signal.SIGINT, exit_wrapper)
    signal.signal(signal.SIGUSR1, interrupt_active_turn)

    emit({"type": "system", "subtype": "wrapper_heartbeat", "phase": "startup"})

    SERVER = subprocess.Popen(
        _build_serve_cmd(),
        stdin=subprocess.DEVNULL,
        stdout=sys.stderr,
        stderr=sys.stderr,
        text=True,
        cwd=os.getcwd(),
        start_new_session=True,
    )

    try:
        _wait_for_server()
        SESSION_ID = _create_or_resume_session()
    except Exception as exc:
        emit({"type": "error", "message": f"opencode startup failed: {exc}"})
        emit(
            {
                "type": "result",
                "subtype": "error",
                "is_error": True,
                "result": f"opencode startup failed: {exc}",
            }
        )
        exit_wrapper()
        return

    threading.Thread(target=_sse_reader, daemon=True).start()
    threading.Thread(target=_stdin_reader, daemon=True).start()
    emit(
        {
            "type": "system",
            "subtype": "wrapper_heartbeat",
            "phase": "app_server_started",
        }
    )
    emit({"type": "system", "subtype": "init", "session_id": SESSION_ID})

    while not SHUTTING_DOWN:
        item = USER_TURNS.get()
        if item is None:
            break
        try:
            handle_user_turn(item)
        except Exception as exc:
            _emit_turn_error(f"wrapper error: {exc}")

    exit_wrapper()
    if SERVER:
        try:
            SERVER.wait(timeout=10)
        except subprocess.TimeoutExpired:
            SERVER.kill()


if __name__ == "__main__":
    main()
