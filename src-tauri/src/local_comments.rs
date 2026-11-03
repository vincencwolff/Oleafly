//! Personal comments live in the app's data directory, never in compiled source
//! or the collaboration document. A revision check protects another window's notes.
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 16 * 1024 * 1024;
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize, Serialize)]
pub struct SavedComments {
    revision: u64,
    data: serde_json::Value,
}

fn read(root: &Path, project_id: &str) -> Result<SavedComments, String> {
    crate::paths::validate_project_id(project_id)?;
    let path = root
        .join("personal-comments")
        .join(format!("{project_id}.json"));
    match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= MAX_BYTES => serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid personal comments: {error}")),
        Ok(_) => Err("personal comments exceed the size limit".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SavedComments {
            revision: 0,
            data: serde_json::json!({ "version": 1, "files": [] }),
        }),
        Err(error) => Err(format!("could not read personal comments: {error}")),
    }
}

fn save(root: &Path, project_id: &str, expected: u64, data: serde_json::Value) -> Result<u64, String> {
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let current = read(root, project_id)?;
    if current.revision != expected {
        return Err("[personal_comments_conflict] Comments changed in another window".into());
    }
    let revision = expected
        .checked_add(1)
        .ok_or("personal comments revision overflow")?;
    let bytes =
        serde_json::to_vec(&SavedComments { revision, data }).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("personal comments exceed the size limit".into());
    }
    let dir = root.join("personal-comments");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    oleafly_core::atomic::write_atomic_private(&dir.join(format!("{project_id}.json")), &bytes)
        .map_err(|error| error.to_string())?;
    Ok(revision)
}

#[tauri::command]
pub async fn personal_comments_load(project_id: String) -> Result<SavedComments, String> {
    tauri::async_runtime::spawn_blocking(move || read(&crate::paths::oleafly_root()?, &project_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn personal_comments_save(
    project_id: String,
    revision: u64,
    data: serde_json::Value,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save(&crate::paths::oleafly_root()?, &project_id, revision, data)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_survive_restart_and_stale_windows_cannot_overwrite_them() {
        let root = tempfile::tempdir().unwrap();
        let data = serde_json::json!({
            "version": 1, "files": [{"path": "main.typ", "notes": ["Überarbeiten"]}]
        });
        assert_eq!(read(root.path(), "paper").unwrap().revision, 0);
        assert_eq!(save(root.path(), "paper", 0, data.clone()).unwrap(), 1);
        assert!(save(root.path(), "paper", 0, serde_json::json!({})).is_err());
        let loaded = read(root.path(), "paper").unwrap();
        assert_eq!(loaded.revision, 1);
        assert_eq!(loaded.data, data);
        assert!(read(root.path(), "other").unwrap().data["files"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn refuses_traversal_and_does_not_replace_a_corrupt_file() {
        let root = tempfile::tempdir().unwrap();
        assert!(save(root.path(), "../escape", 0, serde_json::json!({})).is_err());
        let dir = root.path().join("personal-comments");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("paper.json"), "broken").unwrap();
        assert!(save(root.path(), "paper", 0, serde_json::json!({})).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("paper.json")).unwrap(),
            "broken"
        );
    }
}

#[tauri::command]
pub async fn texpile_comments(project_id: String, events: Option<Vec<serde_json::Value>>) -> Result<String, String> {
    use std::io::{Read, Write};
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::paths::project_dir(&project_id)?;
        let _guard = LOCK.get_or_init(|| Mutex::new(())).lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = root.join(".texpile");
        if events.is_some() {
            match std::fs::create_dir(&dir) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        if dir.exists() && dir.canonicalize().map_err(|error| error.to_string())? != dir {
            return Err("Invalid Texpile metadata directory".into());
        }
        let path = dir.join("comments.jsonl");
        let mut log = String::new();
        match std::fs::symlink_metadata(&path) {
            Ok(info) if info.is_file() => {
                if path.canonicalize().map_err(|error| error.to_string())? != path {
                    return Err("Invalid Texpile comment log".into());
                }
                std::fs::File::open(&path).map_err(|error| error.to_string())?
                    .take((MAX_BYTES + 1) as u64).read_to_string(&mut log)
                    .map_err(|error| error.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err("Invalid Texpile comment log".into()),
        }
        if log.len() > MAX_BYTES {
            return Err("Texpile comments exceed the size limit".into());
        }
        if let Some(events) = events {
            let first = events.first().ok_or("Missing comment event")?;
            let exists = first["id"].as_str().is_some_and(|id| {
                log.lines()
                    .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                    .any(|event| event["t"] == first["t"] && event["id"].as_str() == Some(id))
            });
            if !exists {
                let mut append = String::new();
                if !log.is_empty() && !log.ends_with('\n') {
                    append.push('\n');
                }
                for event in events {
                    append.push_str(&event.to_string());
                    append.push('\n');
                }
                if log.len() + append.len() > MAX_BYTES {
                    return Err("Texpile comments exceed the size limit".into());
                }
                std::fs::OpenOptions::new().create(true).append(true).open(&path)
                    .and_then(|mut file| file.write_all(append.as_bytes()))
                    .map_err(|error| error.to_string())?;
                log.push_str(&append);
            }
        }
        Ok(log)
    }).await.map_err(|error| error.to_string())?
}
