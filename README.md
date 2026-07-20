# Private File Organizer

Local-first desktop app for organizing, searching, and cleaning up private photos and documents without uploading files by default.

## MVP Scope

- Import folders and index files in place.
- Support JPG, PNG, HEIC, PDF, DOCX, and TXT.
- Store file paths, SHA-256 hashes, tags, dates, file type, size, extracted text, and metadata in SQLite.
- Search filenames, tags, document text, and metadata through SQLite FTS5.
- Detect exact duplicates by file hash.
- Manage watched folders and rescan them locally.
- Export metadata as CSV and back up the SQLite database.
- Keep privacy controls visible: no account, no cloud dependency, telemetry disabled by default.

## Stack

- App shell: Tauri 2
- Frontend: React + TypeScript + Vite
- Backend: Rust
- Database/search: SQLite + FTS5 via `rusqlite`
- Hashing: SHA-256 via `sha2`
- Metadata/text extraction: EXIF via `kamadak-exif`, PDF via `lopdf`, DOCX via zipped XML extraction

## Run

```bash
npm install
npm run dev
```

Open the preview UI at `http://127.0.0.1:1420/`.

For the desktop shell:

```bash
npm run desktop
```

For checks:

```bash
npm run build
cd src-tauri
cargo check
```

## Windows Installer

The project includes an NSIS Windows installer build script.

On a Windows computer:

```bash
npm ci
npm run windows:installer
```

The installer is created at:

```text
src-tauri/target/release/bundle/nsis/*.exe
```

To build the installer without using your own Windows computer, push this repo to GitHub and run the included GitHub Actions workflow:

1. Open the repo on GitHub.
2. Go to `Actions`.
3. Select `Build Windows Installer`.
4. Click `Run workflow`.
5. Download the `private-file-organizer-windows-installer` artifact after the build finishes.

Publishing a Git tag like `v0.1.0` also triggers the Windows installer workflow.

## Data Model

The local SQLite database is created under the app data directory as `library.sqlite`.

Tables:

- `files`
- `metadata`
- `tags`
- `file_tags`
- `documents_fts`
- `watch_folders`

Original files are not duplicated by default. The database stores references and extracted index data.

## Roadmap

- Perceptual image hashing for near-duplicate photos.
- OCR for scanned PDFs and images.
- Batch rename and copy-organized-folder export.
- Encrypted database/backups.
- Signed local license key checks.
