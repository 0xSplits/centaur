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
//! * a `tools-bootstrap` init container git-clones the tools repo at a pinned
//!   ref and copies its `source_subdir` into an emptyDir mounted at `/app/tools`
//!   — the same repo-cache architecture (clone a repo into a pre-provisioned
//!   directory, no Dockerfile rebuild to add a tool) without sharing the
//!   repo-cache DaemonSet's node-level cache;
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
/// emptyDir the `tools-bootstrap` init container clones the tools tree into.
const TOOLS_VOLUME: &str = "tools-root";
/// Staging path where `tools-bootstrap` mounts the tools emptyDir. The agent
/// container mounts the same volume read-only at `BASE_TOOL_DIR`.
const TOOLS_BOOTSTRAP_DIR: &str = "/tools-bootstrap";
/// Volume + mount carrying the GitHub token for private-repo clones (askpass).
const GITHUB_TOKEN_VOLUME: &str = "tools-github-token";
const GITHUB_TOKEN_DIR: &str = "/tools-github-token";
const GITHUB_TOKEN_FILE: &str = "token";

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

/// Git source for the base tools tree. When set, every sandbox gets a
/// `tools-bootstrap` init container that clones `repo` at `git_ref` and copies
/// its `source_subdir` into the agent's `/app/tools` — so adding a tool is a
/// push to the repo, not an image rebuild.
#[derive(Clone, Debug)]
pub struct ToolsConfig {
    /// `owner/name` GitHub repo carrying the tools tree.
    pub repo: String,
    /// Branch, tag, or commit to check out. `None` => the repo's default branch.
    pub git_ref: Option<String>,
    /// Subdirectory within the repo holding the tools (copied to `/app/tools`).
    pub source_subdir: String,
    /// Git-capable image the clone init container runs (e.g. the sandbox image).
    pub image: String,
    pub image_pull_policy: Option<String>,
    /// GitHub token secret for private-repo clones. `None` => unauthenticated clone.
    pub github_token: Option<GitHubTokenRef>,
}

/// A Kubernetes Secret key holding a GitHub token, fed to `git` via `GIT_ASKPASS`.
#[derive(Clone, Debug)]
pub struct GitHubTokenRef {
    pub secret_name: String,
    pub secret_key: String,
}

impl ToolsConfig {
    pub fn new(repo: impl Into<String>, image: impl Into<String>) -> Self {
        Self {
            repo: repo.into(),
            git_ref: None,
            source_subdir: "tools".to_owned(),
            image: image.into(),
            image_pull_policy: None,
            github_token: None,
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

/// The `tools-bootstrap` init container: clones `repo` at `git_ref` (sparse, on
/// `source_subdir`) and copies that subtree into the shared `tools-root` emptyDir
/// the agent mounts read-only at `/app/tools`.
pub(crate) fn tools_init_container_json(tools: &ToolsConfig) -> Value {
    let repo_url = format!("https://github.com/{}.git", tools.repo);
    let subdir = &tools.source_subdir;

    // GIT_ASKPASS feeds the token as the HTTPS password (user x-access-token),
    // matching the repo-cache DaemonSet. Wired only when a token secret is mounted.
    let askpass = if tools.github_token.is_some() {
        format!(
            "printf '#!/bin/sh\\ncase \"$1\" in *Username*) echo x-access-token;; \
             *Password*) cat {GITHUB_TOKEN_DIR}/{GITHUB_TOKEN_FILE};; *) echo;; esac\\n' \
             > /tmp/git-askpass\n\
             chmod 0700 /tmp/git-askpass\n\
             export GIT_ASKPASS=/tmp/git-askpass\n"
        )
    } else {
        String::new()
    };

    // `--filter=blob:none --no-checkout` + sparse-checkout fetches only the tools
    // subtree's blobs. With a ref we fetch it explicitly (branch/tag/sha);
    // without one we check out the cloned default branch.
    let checkout = match &tools.git_ref {
        Some(git_ref) => format!(
            "git -C \"$src\" -c gc.auto=0 fetch --quiet origin {git_ref}\n\
             git -C \"$src\" checkout --quiet --detach FETCH_HEAD"
        ),
        None => "git -C \"$src\" checkout --quiet".to_owned(),
    };

    let script = format!(
        "set -e\n\
         {askpass}\
         export GIT_TERMINAL_PROMPT=0\n\
         git config --global --add safe.directory '*'\n\
         src=\"$(mktemp -d)\"\n\
         git clone --quiet --filter=blob:none --no-checkout {repo_url} \"$src\"\n\
         git -C \"$src\" sparse-checkout set {subdir}\n\
         {checkout}\n\
         target=\"{TOOLS_BOOTSTRAP_DIR}\"\n\
         mkdir -p \"$target\"\n\
         cp -R \"$src/{subdir}/.\" \"$target\"/"
    );

    let mut volume_mounts = vec![json!({"name": TOOLS_VOLUME, "mountPath": TOOLS_BOOTSTRAP_DIR})];
    if tools.github_token.is_some() {
        volume_mounts.push(json!({
            "name": GITHUB_TOKEN_VOLUME,
            "mountPath": GITHUB_TOKEN_DIR,
            "readOnly": true,
        }));
    }

    let mut container = json!({
        "name": "tools-bootstrap",
        "image": tools.image,
        "command": ["/bin/sh", "-ec", script],
        "volumeMounts": volume_mounts,
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
pub(crate) fn volumes_json(tools: Option<&ToolsConfig>, overlay: bool) -> Vec<Value> {
    let mut volumes = Vec::new();
    if let Some(tools) = tools {
        volumes.push(json!({"name": TOOLS_VOLUME, "emptyDir": {}}));
        if let Some(token) = &tools.github_token {
            volumes.push(json!({
                "name": GITHUB_TOKEN_VOLUME,
                "secret": {
                    "secretName": token.secret_name,
                    "defaultMode": 0o400,
                    "items": [{"key": token.secret_key, "path": GITHUB_TOKEN_FILE}],
                },
            }));
        }
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
    fn tools_init_clones_repo_into_emptydir() {
        let mut tools = ToolsConfig::new("paradigmxyz/centaur", "centaur-agent:test");
        tools.git_ref = Some("main".to_owned());
        let c = tools_init_container_json(&tools);
        assert_eq!(c["name"], "tools-bootstrap");
        assert_eq!(c["image"], "centaur-agent:test");
        let script = c["command"][2].as_str().unwrap();
        assert!(script.contains("git clone --quiet --filter=blob:none --no-checkout https://github.com/paradigmxyz/centaur.git"));
        assert!(script.contains("sparse-checkout set tools"));
        assert!(script.contains("fetch --quiet origin main"));
        assert!(script.contains("cp -R \"$src/tools/.\" \"$target\"/"));
        // No token configured => no askpass, single (tools) volume mount.
        assert!(!script.contains("GIT_ASKPASS"));
        assert_eq!(c["volumeMounts"].as_array().unwrap().len(), 1);
        assert_eq!(c["volumeMounts"][0]["mountPath"], "/tools-bootstrap");
    }

    #[test]
    fn tools_init_default_ref_checks_out_clone_head() {
        let tools = ToolsConfig::new("paradigmxyz/centaur", "centaur-agent:test");
        let script = tools_init_container_json(&tools)["command"][2]
            .as_str()
            .unwrap()
            .to_owned();
        // Default branch: plain checkout, no explicit ref fetch.
        assert!(script.contains("git -C \"$src\" checkout --quiet\n"));
        assert!(!script.contains("fetch --quiet origin"));
    }

    #[test]
    fn tools_init_with_token_wires_askpass_and_secret_volume() {
        let mut tools = ToolsConfig::new("paradigmxyz/centaur", "centaur-agent:test");
        tools.github_token = Some(GitHubTokenRef {
            secret_name: "centaur-repo-cache-github-token".to_owned(),
            secret_key: "token".to_owned(),
        });
        let c = tools_init_container_json(&tools);
        let script = c["command"][2].as_str().unwrap();
        assert!(script.contains("GIT_ASKPASS=/tmp/git-askpass"));
        assert!(script.contains("/tools-github-token/token"));
        let mounts = c["volumeMounts"].as_array().unwrap();
        assert_eq!(mounts.len(), 2);
        assert!(mounts.iter().any(|m| m["mountPath"] == "/tools-github-token"));

        // The pod gets a secret-backed volume projecting the token to `token`.
        let volumes = volumes_json(Some(&tools), false);
        let token_vol = volumes
            .iter()
            .find(|v| v["name"] == GITHUB_TOKEN_VOLUME)
            .expect("token volume");
        assert_eq!(
            token_vol["secret"]["secretName"],
            "centaur-repo-cache-github-token"
        );
        assert_eq!(token_vol["secret"]["items"][0]["path"], "token");
    }

    #[test]
    fn volumes_without_token_are_just_emptydirs() {
        let tools = ToolsConfig::new("paradigmxyz/centaur", "centaur-agent:test");
        let volumes = volumes_json(Some(&tools), false);
        assert_eq!(volumes.len(), 1);
        assert_eq!(volumes[0]["name"], TOOLS_VOLUME);
        assert!(volumes[0]["emptyDir"].is_object());
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
