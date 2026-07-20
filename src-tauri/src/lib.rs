use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use exif::{In, Reader, Tag};
use lopdf::Document;
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use walkdir::WalkDir;
use zip::ZipArchive;

struct AppState {
    db_path: PathBuf,
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize)]
struct LibraryFile {
    id: i64,
    path: String,
    filename: String,
    file_hash: String,
    perceptual_hash: Option<String>,
    kind: String,
    mime_type: String,
    size_bytes: i64,
    created_at: Option<String>,
    modified_at: Option<String>,
    imported_at: String,
    tag_names: Vec<String>,
    metadata_preview: Vec<String>,
    snippet: Option<String>,
}

#[derive(Debug, Serialize, Default)]
struct ImportSummary {
    scanned: usize,
    indexed: usize,
    skipped: usize,
    failed: usize,
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
struct DuplicateGroup {
    file_hash: String,
    total_size_bytes: i64,
    files: Vec<LibraryFile>,
}

#[derive(Debug, Serialize)]
struct DashboardStats {
    total_files: i64,
    total_bytes: i64,
    duplicate_groups: i64,
    duplicate_waste_bytes: i64,
    documents: i64,
    photos: i64,
    other: i64,
}

#[derive(Debug, Serialize)]
struct WatchFolder {
    id: i64,
    path: String,
    enabled: bool,
    last_scanned_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct FilePreview {
    preview_type: String,
    html: Option<String>,
    text: Option<String>,
    message: Option<String>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db_path = app
                .path()
                .app_data_dir()
                .context("Unable to resolve app data directory")?
                .join("library.sqlite");
            if let Some(parent) = db_path.parent() {
                fs::create_dir_all(parent).context("Unable to create app data directory")?;
            }
            let conn = Connection::open(&db_path).context("Unable to open local SQLite database")?;
            initialize_database(&conn).context("Unable to initialize local SQLite database")?;
            app.manage(AppState {
                db_path,
                conn: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_folder,
            search_files,
            duplicate_groups,
            dashboard_stats,
            add_tag,
            remove_tag,
            add_watch_folder,
            list_watch_folders,
            scan_watch_folders,
            export_metadata,
            backup_database,
            file_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

fn initialize_database(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          file_hash TEXT NOT NULL,
          perceptual_hash TEXT,
          kind TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at TEXT,
          modified_at TEXT,
          imported_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS metadata (
          file_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (file_id, key),
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS file_tags (
          file_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          PRIMARY KEY (file_id, tag_id),
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          file_id UNINDEXED,
          title,
          body
        );

        CREATE TABLE IF NOT EXISTS watch_folders (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_scanned_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash);
        CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
        CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON metadata(key, value);
        ",
    )?;
    Ok(())
}

#[tauri::command]
fn import_folder(state: tauri::State<AppState>, path: String) -> Result<ImportSummary, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    scan_folder(&conn, Path::new(&path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn search_files(
    state: tauri::State<AppState>,
    query: String,
    kind: String,
    duplicate_only: bool,
) -> Result<Vec<LibraryFile>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    query_files(&conn, &query, &kind, duplicate_only).map_err(|error| error.to_string())
}

#[tauri::command]
fn duplicate_groups(state: tauri::State<AppState>) -> Result<Vec<DuplicateGroup>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(
            "
            SELECT file_hash, SUM(size_bytes) AS total_size_bytes
            FROM files
            GROUP BY file_hash
            HAVING COUNT(*) > 1
            ORDER BY total_size_bytes DESC
            LIMIT 50
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;

    let mut groups = Vec::new();
    for row in rows {
        let (file_hash, total_size_bytes) = row.map_err(|error| error.to_string())?;
        let files = files_by_hash(&conn, &file_hash).map_err(|error| error.to_string())?;
        groups.push(DuplicateGroup {
            file_hash,
            total_size_bytes,
            files,
        });
    }
    Ok(groups)
}

#[tauri::command]
fn dashboard_stats(state: tauri::State<AppState>) -> Result<DashboardStats, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let total_files = scalar_i64(&conn, "SELECT COUNT(*) FROM files")?;
    let total_bytes = scalar_i64(&conn, "SELECT COALESCE(SUM(size_bytes), 0) FROM files")?;
    let documents = scalar_i64(&conn, "SELECT COUNT(*) FROM files WHERE kind IN ('document', 'text')")?;
    let photos = scalar_i64(&conn, "SELECT COUNT(*) FROM files WHERE kind = 'photo'")?;
    let other = total_files - documents - photos;
    let duplicate_groups = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM (SELECT file_hash FROM files GROUP BY file_hash HAVING COUNT(*) > 1)",
    )?;
    let duplicate_waste_bytes = scalar_i64(
        &conn,
        "
        SELECT COALESCE(SUM(waste), 0)
        FROM (
          SELECT SUM(size_bytes) - MIN(size_bytes) AS waste
          FROM files
          GROUP BY file_hash
          HAVING COUNT(*) > 1
        )
        ",
    )?;
    Ok(DashboardStats {
        total_files,
        total_bytes,
        duplicate_groups,
        duplicate_waste_bytes,
        documents,
        photos,
        other,
    })
}

#[tauri::command]
fn add_tag(state: tauri::State<AppState>, file_id: i64, tag: String) -> Result<(), String> {
    let normalized = tag.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(());
    }
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?1)", params![normalized])
        .map_err(|error| error.to_string())?;
    let tag_id: i64 = conn
        .query_row("SELECT id FROM tags WHERE name = ?1", params![normalized], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO file_tags(file_id, tag_id) VALUES (?1, ?2)",
        params![file_id, tag_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn remove_tag(state: tauri::State<AppState>, file_id: i64, tag: String) -> Result<(), String> {
    let normalized = tag.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(());
    }
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let tag_id: Option<i64> = conn
        .query_row("SELECT id FROM tags WHERE name = ?1", params![normalized], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(tag_id) = tag_id else {
        return Ok(());
    };
    conn.execute(
        "DELETE FROM file_tags WHERE file_id = ?1 AND tag_id = ?2",
        params![file_id, tag_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM tags WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM file_tags WHERE tag_id = ?1)",
        params![tag_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_watch_folder(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO watch_folders(path, enabled) VALUES (?1, 1)",
        params![path],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_watch_folders(state: tauri::State<AppState>) -> Result<Vec<WatchFolder>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, path, enabled, last_scanned_at FROM watch_folders ORDER BY path")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WatchFolder {
                id: row.get(0)?,
                path: row.get(1)?,
                enabled: row.get::<_, i64>(2)? == 1,
                last_scanned_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn scan_watch_folders(state: tauri::State<AppState>) -> Result<ImportSummary, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let folders = list_watch_folders_for_conn(&conn).map_err(|error| error.to_string())?;
    let mut total = ImportSummary::default();
    for folder in folders.into_iter().filter(|folder| folder.enabled) {
        match scan_folder(&conn, Path::new(&folder.path)) {
            Ok(summary) => {
                total.scanned += summary.scanned;
                total.indexed += summary.indexed;
                total.skipped += summary.skipped;
                total.failed += summary.failed;
                total.errors.extend(summary.errors);
                conn.execute(
                    "UPDATE watch_folders SET last_scanned_at = ?1 WHERE id = ?2",
                    params![Utc::now().to_rfc3339(), folder.id],
                )
                .map_err(|error| error.to_string())?;
            }
            Err(error) => {
                total.failed += 1;
                total.errors.push(format!("{}: {error}", folder.path));
            }
        }
    }
    Ok(total)
}

#[tauri::command]
fn export_metadata(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let files = query_files(&conn, "", "all", false).map_err(|error| error.to_string())?;
    let mut writer = csv::Writer::from_path(path).map_err(|error| error.to_string())?;
    writer
        .write_record([
            "id",
            "path",
            "file_hash",
            "kind",
            "mime_type",
            "size_bytes",
            "created_at",
            "modified_at",
            "imported_at",
            "tags",
            "metadata",
        ])
        .map_err(|error| error.to_string())?;
    for file in files {
        writer
            .write_record([
                file.id.to_string(),
                file.path,
                file.file_hash,
                file.kind,
                file.mime_type,
                file.size_bytes.to_string(),
                file.created_at.unwrap_or_default(),
                file.modified_at.unwrap_or_default(),
                file.imported_at,
                file.tag_names.join("|"),
                file.metadata_preview.join("|"),
            ])
            .map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn backup_database(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let _guard = state.conn.lock().map_err(|error| error.to_string())?;
    fs::copy(&state.db_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn file_preview(state: tauri::State<AppState>, file_id: i64) -> Result<FilePreview, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let (path, kind, mime_type): (String, String, String) = conn
        .query_row(
            "SELECT path, kind, mime_type FROM files WHERE id = ?1",
            params![file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let path = PathBuf::from(path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if kind == "photo" {
        return Ok(FilePreview {
            preview_type: "image".to_string(),
            html: None,
            text: None,
            message: None,
        });
    }

    if extension == "pdf" || mime_type == "application/pdf" {
        return Ok(FilePreview {
            preview_type: "pdf".to_string(),
            html: None,
            text: None,
            message: None,
        });
    }

    if extension == "docx" {
        let html = extract_docx_preview_html(&path).map_err(|error| error.to_string())?;
        return Ok(FilePreview {
            preview_type: "docx".to_string(),
            html: Some(html),
            text: None,
            message: None,
        });
    }

    if extension == "txt" || kind == "text" {
        let text = fs::read_to_string(&path)
            .map(|text| truncate_text(&text, 80_000))
            .map_err(|error| error.to_string())?;
        return Ok(FilePreview {
            preview_type: "text".to_string(),
            html: None,
            text: Some(text),
            message: None,
        });
    }

    Ok(FilePreview {
        preview_type: "unsupported".to_string(),
        html: None,
        text: None,
        message: Some("This file type is indexed, but no renderer is available yet.".to_string()),
    })
}

fn scan_folder(conn: &Connection, folder: &Path) -> Result<ImportSummary> {
    if !folder.exists() || !folder.is_dir() {
        anyhow::bail!("Folder does not exist: {}", folder.display());
    }

    let mut summary = ImportSummary::default();
    for entry in WalkDir::new(folder)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        summary.scanned += 1;
        let path = entry.path();
        if !is_supported_file(path) {
            summary.skipped += 1;
            continue;
        }
        match index_file(conn, path) {
            Ok(indexed) => {
                if indexed {
                    summary.indexed += 1;
                } else {
                    summary.skipped += 1;
                }
            }
            Err(error) => {
                summary.failed += 1;
                if summary.errors.len() < 10 {
                    summary.errors.push(format!("{}: {error}", path.display()));
                }
            }
        }
    }
    Ok(summary)
}

fn index_file(conn: &Connection, path: &Path) -> Result<bool> {
    let canonical = path.canonicalize().with_context(|| format!("Unable to resolve {}", path.display()))?;
    let path_string = canonical.to_string_lossy().to_string();
    let file_metadata = fs::metadata(&canonical)?;
    let modified_at = system_time_to_rfc3339(file_metadata.modified().ok());

    let existing_modified: Option<String> = conn
        .query_row(
            "SELECT modified_at FROM files WHERE path = ?1",
            params![path_string],
            |row| row.get(0),
        )
        .optional()?;
    if existing_modified.is_some() && existing_modified == modified_at {
        return Ok(false);
    }

    let hash = sha256_file(&canonical)?;
    let mime_type = infer::get_from_path(&canonical)?
        .map(|kind| kind.mime_type().to_string())
        .unwrap_or_else(|| mime_from_extension(&canonical));
    let kind = kind_for_file(&canonical, &mime_type);
    let created_at = system_time_to_rfc3339(file_metadata.created().ok());
    let imported_at = Utc::now().to_rfc3339();

    conn.execute(
        "
        INSERT INTO files(path, file_hash, perceptual_hash, kind, mime_type, size_bytes, created_at, modified_at, imported_at)
        VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(path) DO UPDATE SET
          file_hash = excluded.file_hash,
          kind = excluded.kind,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          created_at = excluded.created_at,
          modified_at = excluded.modified_at,
          imported_at = excluded.imported_at
        ",
        params![
            path_string,
            hash,
            kind,
            mime_type,
            file_metadata.len() as i64,
            created_at,
            modified_at,
            imported_at
        ],
    )?;
    let file_id: i64 = conn.query_row("SELECT id FROM files WHERE path = ?1", params![path_string], |row| row.get(0))?;

    conn.execute("DELETE FROM metadata WHERE file_id = ?1", params![file_id])?;
    conn.execute("DELETE FROM documents_fts WHERE file_id = ?1", params![file_id])?;

    for (key, value) in extract_metadata(&canonical, &kind)? {
        conn.execute(
            "INSERT OR REPLACE INTO metadata(file_id, key, value) VALUES (?1, ?2, ?3)",
            params![file_id, key, value],
        )?;
    }

    let extracted_text = extract_text(&canonical, &kind).unwrap_or_default();
    let title = canonical
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path_string.clone());
    conn.execute(
        "INSERT INTO documents_fts(file_id, title, body) VALUES (?1, ?2, ?3)",
        params![file_id, title, extracted_text],
    )?;

    Ok(true)
}

fn query_files(conn: &Connection, query: &str, kind: &str, duplicate_only: bool) -> Result<Vec<LibraryFile>> {
    let mut sql = String::from(
        "
        SELECT DISTINCT f.id, f.path, f.file_hash, f.perceptual_hash, f.kind, f.mime_type,
               f.size_bytes, f.created_at, f.modified_at, f.imported_at,
               snippet(documents_fts, 2, '[', ']', '...', 18) AS snippet
        FROM files f
        LEFT JOIN documents_fts ON documents_fts.file_id = f.id
        LEFT JOIN file_tags ft ON ft.file_id = f.id
        LEFT JOIN tags t ON t.id = ft.tag_id
        ",
    );

    let mut conditions = Vec::new();
    let mut values = Vec::new();
    if !query.trim().is_empty() {
        conditions.push(
            "(f.path LIKE ? OR t.name LIKE ? OR f.id IN (SELECT file_id FROM documents_fts WHERE documents_fts MATCH ?))",
        );
        let like = format!("%{}%", query.trim());
        values.push(like.clone());
        values.push(like);
        values.push(fts_query(query));
    }
    if kind != "all" {
        conditions.push("f.kind = ?");
        values.push(kind.to_string());
    }
    if duplicate_only {
        conditions.push("f.file_hash IN (SELECT file_hash FROM files GROUP BY file_hash HAVING COUNT(*) > 1)");
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY f.modified_at DESC, f.imported_at DESC LIMIT 500");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| file_from_row(conn, row))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn files_by_hash(conn: &Connection, file_hash: &str) -> Result<Vec<LibraryFile>> {
    let mut stmt = conn.prepare(
        "
        SELECT f.id, f.path, f.file_hash, f.perceptual_hash, f.kind, f.mime_type,
               f.size_bytes, f.created_at, f.modified_at, f.imported_at,
               NULL AS snippet
        FROM files f
        WHERE f.file_hash = ?1
        ORDER BY f.modified_at DESC
        ",
    )?;
    let rows = stmt.query_map(params![file_hash], |row| file_from_row(conn, row))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn file_from_row(conn: &Connection, row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryFile> {
    let id: i64 = row.get(0)?;
    let path: String = row.get(1)?;
    let filename = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(LibraryFile {
        id,
        path,
        filename,
        file_hash: row.get(2)?,
        perceptual_hash: row.get(3)?,
        kind: row.get(4)?,
        mime_type: row.get(5)?,
        size_bytes: row.get(6)?,
        created_at: row.get(7)?,
        modified_at: row.get(8)?,
        imported_at: row.get(9)?,
        tag_names: tag_names(conn, id)?,
        metadata_preview: metadata_preview(conn, id)?,
        snippet: row.get(10)?,
    })
}

fn tag_names(conn: &Connection, file_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id = t.id WHERE ft.file_id = ?1 ORDER BY t.name",
    )?;
    let tags = stmt.query_map(params![file_id], |row| row.get(0))?.collect();
    tags
}

fn metadata_preview(conn: &Connection, file_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM metadata WHERE file_id = ?1 ORDER BY key LIMIT 8")?;
    let metadata = stmt.query_map(params![file_id], |row| {
        let key: String = row.get(0)?;
        let value: String = row.get(1)?;
        Ok(format!("{key}: {value}"))
    })?
    .collect();
    metadata
}

fn list_watch_folders_for_conn(conn: &Connection) -> Result<Vec<WatchFolder>> {
    let mut stmt = conn.prepare("SELECT id, path, enabled, last_scanned_at FROM watch_folders ORDER BY path")?;
    let rows = stmt.query_map([], |row| {
        Ok(WatchFolder {
            id: row.get(0)?,
            path: row.get(1)?,
            enabled: row.get::<_, i64>(2)? == 1,
            last_scanned_at: row.get(3)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn scalar_i64(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn is_supported_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "heic" | "pdf" | "docx" | "txt")
    )
}

fn kind_for_file(path: &Path, mime_type: &str) -> String {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if mime_type.starts_with("image/") || matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "heic") {
        "photo".to_string()
    } else if extension == "txt" || mime_type == "text/plain" {
        "text".to_string()
    } else if matches!(extension.as_str(), "pdf" | "docx") {
        "document".to_string()
    } else {
        "other".to_string()
    }
}

fn mime_from_extension(path: &Path) -> String {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_metadata(path: &Path, kind: &str) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    values.insert(
        "source_folder".to_string(),
        path.parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    if kind == "photo" {
        if let Ok(file) = File::open(path) {
            let mut reader = BufReader::new(file);
            if let Ok(exif) = Reader::new().read_from_container(&mut reader) {
                for (key, tag) in [
                    ("camera_make", Tag::Make),
                    ("camera_model", Tag::Model),
                    ("photo_date", Tag::DateTimeOriginal),
                    ("gps_latitude", Tag::GPSLatitude),
                    ("gps_longitude", Tag::GPSLongitude),
                ] {
                    if let Some(field) = exif.get_field(tag, In::PRIMARY) {
                        values.insert(key.to_string(), field.display_value().with_unit(&exif).to_string());
                    }
                }
            }
        }
    }
    if kind == "document" && path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")) {
        if let Ok(doc) = Document::load(path) {
            values.insert("pages".to_string(), doc.get_pages().len().to_string());
        }
    }
    Ok(values)
}

fn extract_text(path: &Path, kind: &str) -> Result<String> {
    if kind == "text" {
        return fs::read_to_string(path).map(|text| truncate_text(&text, 1_000_000)).map_err(Into::into);
    }
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "pdf" => extract_pdf_text(path),
        "docx" => extract_docx_text(path),
        _ => Ok(String::new()),
    }
}

fn extract_pdf_text(path: &Path) -> Result<String> {
    let doc = Document::load(path)?;
    let mut text = String::new();
    for (page_num, _page_id) in doc.get_pages() {
        if let Ok(page_text) = doc.extract_text(&[page_num]) {
            text.push_str(&page_text);
            text.push('\n');
        }
        if text.len() > 1_000_000 {
            break;
        }
    }
    Ok(truncate_text(&text, 1_000_000))
}

fn extract_docx_text(path: &Path) -> Result<String> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut document_xml = String::new();
    archive
        .by_name("word/document.xml")?
        .read_to_string(&mut document_xml)?;
    let mut reader = XmlReader::from_str(&document_xml);
    reader.config_mut().trim_text(true);
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(event)) => {
                if let Ok(value) = event.unescape() {
                    text.push_str(&value);
                    text.push(' ');
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.into()),
            _ => {}
        }
    }
    Ok(truncate_text(&text, 1_000_000))
}

fn extract_docx_preview_html(path: &Path) -> Result<String> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut document_xml = String::new();
    archive
        .by_name("word/document.xml")?
        .read_to_string(&mut document_xml)?;

    let mut reader = XmlReader::from_str(&document_xml);
    reader.config_mut().trim_text(true);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_paragraph = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = event.name();
                let name = name.as_ref();
                if is_docx_tag(name, b"p") {
                    in_paragraph = true;
                    current.clear();
                } else if in_paragraph && is_docx_tag(name, b"tab") {
                    current.push('\t');
                } else if in_paragraph && is_docx_tag(name, b"br") {
                    current.push('\n');
                }
            }
            Ok(Event::Empty(event)) => {
                let name = event.name();
                let name = name.as_ref();
                if in_paragraph && is_docx_tag(name, b"tab") {
                    current.push('\t');
                } else if in_paragraph && is_docx_tag(name, b"br") {
                    current.push('\n');
                }
            }
            Ok(Event::Text(event)) => {
                if in_paragraph {
                    if let Ok(value) = event.unescape() {
                        current.push_str(&value);
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name = event.name();
                let name = name.as_ref();
                if is_docx_tag(name, b"p") {
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed.to_string());
                    }
                    current.clear();
                    in_paragraph = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.into()),
            _ => {}
        }

        if paragraphs.len() >= 500 {
            break;
        }
    }

    if paragraphs.is_empty() {
        return Ok("<article><p>No readable DOCX text was found.</p></article>".to_string());
    }

    let mut html = String::from("<article>");
    for paragraph in paragraphs {
        let escaped = escape_html(&paragraph).replace('\n', "<br>").replace('\t', "&emsp;");
        html.push_str("<p>");
        html.push_str(&escaped);
        html.push_str("</p>");
    }
    html.push_str("</article>");
    Ok(html)
}

fn is_docx_tag(name: &[u8], local_name: &[u8]) -> bool {
    name == local_name || name.rsplit(|byte| *byte == b':').next() == Some(local_name)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        text.chars().take(max_len).collect()
    }
}

fn system_time_to_rfc3339(value: Option<std::time::SystemTime>) -> Option<String> {
    value.map(|time| DateTime::<Utc>::from(time).to_rfc3339())
}

fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|part| format!("{}*", part.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}
