//! Durable session control-plane types.
//!
//! A session is the public control-plane object for one ongoing agent
//! conversation. `thread_key` is the canonical identifier.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;
use thiserror::Error;
use time::OffsetDateTime;

pub const MAX_THREAD_KEY_BYTES: usize = 512;
pub const SUPPORTED_HARNESS_TYPES: &[&str] = &["codex", "amp", "claudecode"];

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct ThreadKey(String);

impl ThreadKey {
    pub fn parse(value: impl Into<String>) -> Result<Self, ThreadKeyError> {
        let value = value.into();
        validate_thread_key(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for ThreadKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ThreadKey {
    type Err = ThreadKeyError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl TryFrom<String> for ThreadKey {
    type Error = ThreadKeyError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl AsRef<str> for ThreadKey {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Serialize for ThreadKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ThreadKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum ThreadKeyError {
    #[error("thread_key is required")]
    Empty,
    #[error("thread_key must be at most {MAX_THREAD_KEY_BYTES} bytes")]
    TooLong,
    #[error("thread_key must be namespaced as '<source>:<id>'")]
    MissingNamespace,
    #[error("thread_key must not contain ASCII control characters")]
    ControlCharacter,
    #[error("thread_key must not be raw JSON")]
    RawJson,
}

fn validate_thread_key(value: &str) -> Result<(), ThreadKeyError> {
    if value.is_empty() {
        return Err(ThreadKeyError::Empty);
    }
    if value.len() > MAX_THREAD_KEY_BYTES {
        return Err(ThreadKeyError::TooLong);
    }
    if value.starts_with('{') || value.starts_with('[') {
        return Err(ThreadKeyError::RawJson);
    }
    if value.chars().any(|ch| ch.is_ascii_control()) {
        return Err(ThreadKeyError::ControlCharacter);
    }
    let Some((namespace, rest)) = value.split_once(':') else {
        return Err(ThreadKeyError::MissingNamespace);
    };
    if namespace.is_empty() || rest.is_empty() {
        return Err(ThreadKeyError::MissingNamespace);
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum HarnessType {
    Codex,
    Amp,
    ClaudeCode,
}

impl HarnessType {
    pub fn parse(value: impl Into<String>) -> Result<Self, HarnessTypeError> {
        let value = value.into();
        match value.as_str() {
            "" => Err(HarnessTypeError::Empty),
            "codex" => Ok(Self::Codex),
            "amp" => Ok(Self::Amp),
            "claudecode" => Ok(Self::ClaudeCode),
            _ => Err(HarnessTypeError::Unsupported),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Codex => "codex",
            Self::Amp => "amp",
            Self::ClaudeCode => "claudecode",
        }
    }

    pub fn into_string(self) -> String {
        self.as_str().to_owned()
    }
}

impl fmt::Display for HarnessType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for HarnessType {
    type Err = HarnessTypeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for HarnessType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HarnessType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum HarnessTypeError {
    #[error("harness_type is required")]
    Empty,
    #[error("harness_type must be one of: codex, amp, claudecode")]
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Idle,
    Executing,
    Failed,
    Archived,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Idle => "idle",
            Self::Executing => "executing",
            Self::Failed => "failed",
            Self::Archived => "archived",
        }
    }
}

impl FromStr for SessionStatus {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "idle" => Ok(Self::Idle),
            "executing" => Ok(Self::Executing),
            "failed" => Ok(Self::Failed),
            "archived" => Ok(Self::Archived),
            _ => Err(ParseEnumError::new("session status", value)),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub thread_key: ThreadKey,
    pub sandbox_id: Option<String>,
    pub harness_type: HarnessType,
    pub harness_thread_id: Option<String>,
    pub status: SessionStatus,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
            Self::Tool => "tool",
        }
    }
}

impl FromStr for MessageRole {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            "system" => Ok(Self::System),
            "tool" => Ok(Self::Tool),
            _ => Err(ParseEnumError::new("message role", value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionMessageInput {
    pub role: MessageRole,
    pub parts: Vec<Value>,
    #[serde(default = "empty_object")]
    pub metadata: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionMessage {
    pub message_id: String,
    pub thread_key: ThreadKey,
    pub role: MessageRole,
    pub parts: Vec<Value>,
    pub metadata: Value,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl ExecutionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for ExecutionStatus {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(ParseEnumError::new("execution status", value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionExecution {
    pub execution_id: String,
    pub thread_key: ThreadKey,
    pub status: ExecutionStatus,
    pub metadata: Value,
    pub error: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub started_at: Option<OffsetDateTime>,
    pub completed_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionEvent {
    pub event_id: i64,
    pub thread_key: ThreadKey,
    pub execution_id: Option<String>,
    pub event_type: String,
    pub payload: Value,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Error)]
#[error("invalid {kind}: {value}")]
pub struct ParseEnumError {
    kind: &'static str,
    value: String,
}

impl ParseEnumError {
    fn new(kind: &'static str, value: &str) -> Self {
        Self {
            kind,
            value: value.to_owned(),
        }
    }
}

pub fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

#[cfg(test)]
mod tests {
    use super::{HarnessType, ThreadKey};

    #[test]
    fn thread_key_accepts_namespaced_values() {
        let key = ThreadKey::parse("slack:C123:1780000000.000000").unwrap();
        assert_eq!(key.as_str(), "slack:C123:1780000000.000000");
    }

    #[test]
    fn thread_key_rejects_missing_namespace() {
        let err = ThreadKey::parse("not-namespaced").unwrap_err();
        assert_eq!(
            err.to_string(),
            "thread_key must be namespaced as '<source>:<id>'"
        );
    }

    #[test]
    fn thread_key_rejects_unbounded_payload_shape() {
        let err = ThreadKey::parse("{\"thread\":\"x\"}").unwrap_err();
        assert_eq!(err.to_string(), "thread_key must not be raw JSON");
    }

    #[test]
    fn harness_type_accepts_supported_values() {
        assert_eq!(HarnessType::parse("codex").unwrap(), HarnessType::Codex);
        assert_eq!(HarnessType::parse("amp").unwrap(), HarnessType::Amp);
        assert_eq!(
            HarnessType::parse("claudecode").unwrap(),
            HarnessType::ClaudeCode
        );
    }

    #[test]
    fn harness_type_rejects_unsupported_values() {
        let err = HarnessType::parse("claude-code").unwrap_err();
        assert_eq!(
            err.to_string(),
            "harness_type must be one of: codex, amp, claudecode"
        );
    }
}
