//! Tool sources + gerard overlay wiring for agent sandboxes.
//!
//! api-rs serves no `/tools` HTTP registry and the agent's `call <tool>` HTTP
//! registry is deprecated upstream (control-plane-only). Instead the agent
//! image installs each tool as a shell CLI shim at entrypoint
//! (`services/sandbox/install_tool_shims.py`) by scanning `TOOL_DIRS` for
//! `pyproject.toml [project.scripts]` and `uvx`-installing each. Secrets ride
//! proxied env (tool placeholder creds + `*_DSN` from `apply_proxy_env`,
//! granted per-sandbox by iron-control) — none of that lives here.
//!
//! What this module provides is the *sources* the shims install from, mounted
//! INTO the agent container at the SAME paths the api-rs pod's own `TOOL_DIRS`
//! points at (so api-rs's `tool_discovery` and the agent agree on tool paths):
//!
//! * a `tools-bootstrap` init container copies `/app/tools` out of the shared
//!   `centaur-api` image into an emptyDir mounted at `/app/tools`;
//! * an `overlay-bootstrap` init container copies the org overlay image's tree
//!   into the overlay-root emptyDir, mounted at the overlay `mount_path` (and
//!   stages the overlay's `SYSTEM_PROMPT.md` as `$HOME/AGENTS_OVERLAY.md`, which
//!   the sandbox entrypoint appends to the base prompt).
//!
//! `TOOL_DIRS` is set explicitly on the agent env to `/app/tools` (or
//! `/app/tools:<mount_path>/tools` when the overlay is configured), matching the
//! value the api-rs Deployment computes for itself.

use serde_json::{Value, json};

const AGENT_UID: i64 = 1001;

/// Base tools path inside both the api-rs pod and the agent sandbox.
pub(crate) const BASE_TOOL_DIR: &str = "/app/tools";
/// emptyDir the `tools-bootstrap` init container populates from the source image.
const TOOLS_VOLUME: &str = "tools-root";
/// Staging path where `tools-bootstrap` mounts the tools emptyDir. Must differ
/// from `BASE_TOOL_DIR`: mounting the volume at `/app/tools` would shadow the
/// source image's own tools tree, so the copy would read the empty volume and
/// `cp` would reject the self-copy (exit 1, sandbox never starts). The agent
/// container mounts the same volume at `BASE_TOOL_DIR`.
const TOOLS_BOOTSTRAP_DIR: &str = "/tools-bootstrap";

/// Shared overlay-tree volume (populated by `overlay-bootstrap`).
const OVERLAY_VOLUME: &str = "overlay-root";

// The overlay's `SYSTEM_PROMPT.md` is staged by the init container into a tiny
// shared volume and surfaced to the agent at `$HOME/AGENTS_OVERLAY.md`, which the
// sandbox entrypoint appends to the base prompt.
const OVERLAY_PROMPT_VOLUME: &str = "overlay-prompt";
const OVERLAY_PROMPT_DIR: &str = "/overlay-prompt";
const OVERLAY_PROMPT_FILE: &str = "AGENTS_OVERLAY.md";
const AGENT_OVERLAY_PROMPT_PATH: &str = "/home/agent/AGENTS_OVERLAY.md";
const OVERLAY_SYSTEM_PROMPT_REL: &str = "services/sandbox/SYSTEM_PROMPT.md";

/// Source image carrying the base tools at `/app/tools` (the shared
/// `centaur-api` image). When set, every sandbox gets a `tools-bootstrap` init
/// container that copies those tools into the agent's `/app/tools`.
#[derive(Clone, Debug)]
pub struct ToolsConfig {
    pub image: String,
    pub image_pull_policy: Option<String>,
}

impl ToolsConfig {
    pub fn new(image: impl Into<String>) -> Self {
        Self {
            image: image.into(),
            image_pull_policy: None,
        }
    }
}

/// Org overlay image + where its tree lands in the sandbox. `mount_path` matches
/// the api-rs pod's `overlay.mountPath` so the agent's `<mount_path>/tools` is
/// the same path api-rs discovered tools at.
#[derive(Clone, Debug)]
pub struct OverlayConfig {
    pub image: String,
    pub image_pull_policy: Option<String>,
    /// Path the overlay tree is copied from inside the overlay image.
    pub source_path: String,
    /// Path the overlay tree is mounted at in the sandbox (e.g. `/app/overlay/org`).
    pub mount_path: String,
}

impl OverlayConfig {
    pub fn new(image: impl Into<String>) -> Self {
        Self {
            image: image.into(),
            image_pull_policy: None,
            source_path: "/overlay".to_owned(),
            mount_path: "/app/overlay/org".to_owned(),
        }
    }

    /// Parent dir the overlay-root emptyDir is mounted at (so the copy lands at
    /// `mount_path`). Falls back to `mount_path` itself if it has no parent.
    fn overlay_root(&self) -> &str {
        match self.mount_path.rfind('/') {
            Some(0) | None => &self.mount_path,
            Some(idx) => &self.mount_path[..idx],
        }
    }
}

fn security_context_json() -> Value {
    json!({
        "allowPrivilegeEscalation": false,
        "capabilities": {"drop": ["ALL"]},
        "runAsGroup": AGENT_UID,
        "runAsNonRoot": true,
        "runAsUser": AGENT_UID,
        "seccompProfile": {"type": "RuntimeDefault"},
    })
}

pub(crate) fn pod_security_context_json() -> Value {
    json!({
        "fsGroup": AGENT_UID,
        "fsGroupChangePolicy": "OnRootMismatch",
    })
}

/// `TOOL_DIRS` for the agent: base tools plus the overlay's tools when present.
/// Matches the value the api-rs Deployment computes for its own `TOOL_DIRS`.
pub(crate) fn agent_tool_dirs(overlay: Option<&OverlayConfig>) -> String {
    match overlay {
        Some(overlay) => format!("{BASE_TOOL_DIR}:{}/tools", overlay.mount_path),
        None => BASE_TOOL_DIR.to_owned(),
    }
}

/// Agent env added for tools/overlay wiring: `TOOL_DIRS` (always) and
/// `CENTAUR_OVERLAY_DIR` (when the overlay is configured).
pub(crate) fn agent_env(overlay: Option<&OverlayConfig>) -> Vec<(String, String)> {
    let mut env = vec![("TOOL_DIRS".to_owned(), agent_tool_dirs(overlay))];
    if let Some(overlay) = overlay {
        env.push(("CENTAUR_OVERLAY_DIR".to_owned(), overlay.mount_path.clone()));
    }
    env
}

/// The `tools-bootstrap` init container: copies `/app/tools` out of the source
/// image into the shared `tools-root` emptyDir mounted at `/app/tools`.
pub(crate) fn tools_init_container_json(tools: &ToolsConfig) -> Value {
    let script = format!(
        "src=\"{BASE_TOOL_DIR}\"\n\
         target=\"{TOOLS_BOOTSTRAP_DIR}\"\n\
         mkdir -p \"$target\"\n\
         cp -R \"$src\"/. \"$target\"/",
    );
    let mut container = json!({
        "name": "tools-bootstrap",
        "image": tools.image,
        "command": ["/bin/sh", "-ec", script],
        "volumeMounts": [
            {"name": TOOLS_VOLUME, "mountPath": TOOLS_BOOTSTRAP_DIR},
        ],
        "securityContext": security_context_json(),
    });
    if let Some(policy) = &tools.image_pull_policy {
        container["imagePullPolicy"] = json!(policy);
    }
    container
}

/// The `overlay-bootstrap` init container: copies the overlay image's tree into
/// the shared `overlay-root` emptyDir, and stages the overlay's
/// `SYSTEM_PROMPT.md` as `AGENTS_OVERLAY.md` in a small shared volume.
pub(crate) fn overlay_init_container_json(overlay: &OverlayConfig) -> Value {
    let script = format!(
        "src=\"{src}\"\n\
         target=\"{target}\"\n\
         mkdir -p \"$target\"\n\
         cp -R \"$src\"/. \"$target\"/\n\
         if [ -f \"$target/{prompt_rel}\" ]; then\n\
         \x20 cp \"$target/{prompt_rel}\" \"{prompt_dir}/{prompt_file}\"\n\
         else\n\
         \x20 : > \"{prompt_dir}/{prompt_file}\"\n\
         fi",
        src = overlay.source_path,
        target = overlay.mount_path,
        prompt_rel = OVERLAY_SYSTEM_PROMPT_REL,
        prompt_dir = OVERLAY_PROMPT_DIR,
        prompt_file = OVERLAY_PROMPT_FILE,
    );
    let mut container = json!({
        "name": "overlay-bootstrap",
        "image": overlay.image,
        "command": ["/bin/sh", "-ec", script],
        "volumeMounts": [
            {"name": OVERLAY_VOLUME, "mountPath": overlay.overlay_root()},
            {"name": OVERLAY_PROMPT_VOLUME, "mountPath": OVERLAY_PROMPT_DIR},
        ],
        "securityContext": security_context_json(),
    });
    if let Some(policy) = &overlay.image_pull_policy {
        container["imagePullPolicy"] = json!(policy);
    }
    container
}

/// Volumes added to the pod for tool sources (and, when enabled, the overlay
/// tree + prompt-handoff volume).
pub(crate) fn volumes_json(tools: bool, overlay: bool) -> Vec<Value> {
    let mut volumes = Vec::new();
    if tools {
        volumes.push(json!({"name": TOOLS_VOLUME, "emptyDir": {}}));
    }
    if overlay {
        volumes.push(json!({"name": OVERLAY_VOLUME, "emptyDir": {}}));
        volumes.push(json!({"name": OVERLAY_PROMPT_VOLUME, "emptyDir": {}}));
    }
    volumes
}

/// Volume mounts added to the AGENT container: the base tools tree at
/// `/app/tools` and, when the overlay is enabled, the overlay tree plus the
/// staged overlay prompt at `$HOME/AGENTS_OVERLAY.md`.
pub(crate) fn agent_volume_mounts_json(tools: bool, overlay: Option<&OverlayConfig>) -> Vec<Value> {
    let mut mounts = Vec::new();
    if tools {
        mounts.push(json!({"name": TOOLS_VOLUME, "mountPath": BASE_TOOL_DIR, "readOnly": true}));
    }
    if let Some(overlay) = overlay {
        mounts.push(json!({
            "name": OVERLAY_VOLUME,
            "mountPath": overlay.overlay_root(),
            "readOnly": true,
        }));
        mounts.push(json!({
            "name": OVERLAY_PROMPT_VOLUME,
            "mountPath": AGENT_OVERLAY_PROMPT_PATH,
            "subPath": OVERLAY_PROMPT_FILE,
            "readOnly": true,
        }));
    }
    mounts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_dirs_match_api_rs_pod_value() {
        assert_eq!(agent_tool_dirs(None), "/app/tools");
        let overlay = OverlayConfig::new("centaur-overlay:test");
        assert_eq!(
            agent_tool_dirs(Some(&overlay)),
            "/app/tools:/app/overlay/org/tools"
        );
    }

    #[test]
    fn agent_env_sets_tool_dirs_and_overlay_dir() {
        let env = agent_env(None);
        assert_eq!(env, vec![("TOOL_DIRS".to_owned(), "/app/tools".to_owned())]);

        let overlay = OverlayConfig::new("centaur-overlay:test");
        let env = agent_env(Some(&overlay));
        assert!(env.contains(&(
            "TOOL_DIRS".to_owned(),
            "/app/tools:/app/overlay/org/tools".to_owned()
        )));
        assert!(env.contains(&(
            "CENTAUR_OVERLAY_DIR".to_owned(),
            "/app/overlay/org".to_owned()
        )));
    }

    #[test]
    fn overlay_root_is_mount_path_parent() {
        let overlay = OverlayConfig::new("img");
        assert_eq!(overlay.overlay_root(), "/app/overlay");

        let mut shallow = OverlayConfig::new("img");
        shallow.mount_path = "/overlay".to_owned();
        assert_eq!(shallow.overlay_root(), "/overlay");
    }

    #[test]
    fn tools_init_copies_base_tools_into_emptydir() {
        let tools = ToolsConfig::new("centaur-api:test");
        let c = tools_init_container_json(&tools);
        assert_eq!(c["name"], "tools-bootstrap");
        assert_eq!(c["image"], "centaur-api:test");
        let script = c["command"][2].as_str().unwrap();
        assert!(script.contains("src=\"/app/tools\""));
        assert!(script.contains("target=\"/tools-bootstrap\""));
        // The staging mount must NOT shadow the source image's /app/tools —
        // that would make the copy a self-copy of the empty volume.
        let mount = &c["volumeMounts"][0];
        assert_eq!(mount["name"], TOOLS_VOLUME);
        assert_eq!(mount["mountPath"], "/tools-bootstrap");
    }

    #[test]
    fn overlay_init_stages_prompt_and_mounts_root() {
        let overlay = OverlayConfig::new("centaur-overlay:test");
        let c = overlay_init_container_json(&overlay);
        assert_eq!(c["name"], "overlay-bootstrap");
        let script = c["command"][2].as_str().unwrap();
        assert!(script.contains("target=\"/app/overlay/org\""));
        assert!(script.contains("services/sandbox/SYSTEM_PROMPT.md"));
        assert!(script.contains("AGENTS_OVERLAY.md"));
        let root_mount = &c["volumeMounts"][0];
        assert_eq!(root_mount["mountPath"], "/app/overlay");
    }

    #[test]
    fn agent_mounts_tools_and_overlay_prompt() {
        let overlay = OverlayConfig::new("centaur-overlay:test");
        let mounts = agent_volume_mounts_json(true, Some(&overlay));
        // base tools, overlay tree, overlay prompt
        assert_eq!(mounts.len(), 3);
        assert!(mounts.iter().any(|m| m["mountPath"] == "/app/tools"));
        assert!(mounts.iter().any(|m| m["mountPath"] == "/app/overlay"));
        let prompt = mounts
            .iter()
            .find(|m| m["mountPath"] == AGENT_OVERLAY_PROMPT_PATH)
            .unwrap();
        assert_eq!(prompt["subPath"], "AGENTS_OVERLAY.md");

        let mounts = agent_volume_mounts_json(true, None);
        assert_eq!(mounts.len(), 1);
    }
}
