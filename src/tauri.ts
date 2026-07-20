import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  DashboardStats,
  DuplicateGroup,
  FilePreview,
  ImportSummary,
  LibraryFile,
  WatchFolder
} from "./types";

const demoFiles: LibraryFile[] = [
  {
    id: 1,
    path: "/Users/local/Clients/Acme/2026-03-contract.pdf",
    filename: "2026-03-contract.pdf",
    file_hash: "demo-contract",
    kind: "document",
    mime_type: "application/pdf",
    size_bytes: 824_120,
    created_at: "2026-03-15T10:40:00Z",
    modified_at: "2026-03-18T08:10:00Z",
    imported_at: "2026-07-17T20:55:00Z",
    tag_names: ["client", "contract"],
    metadata_preview: ["source: Clients", "pages: indexed"],
    snippet: "Service agreement for Acme design retainer..."
  },
  {
    id: 2,
    path: "/Users/local/Receipts/camera-receipt.jpg",
    filename: "camera-receipt.jpg",
    file_hash: "demo-photo-1",
    kind: "photo",
    mime_type: "image/jpeg",
    size_bytes: 3_420_882,
    created_at: "2026-02-08T18:00:00Z",
    modified_at: "2026-02-08T18:05:00Z",
    imported_at: "2026-07-17T20:56:00Z",
    tag_names: ["receipt"],
    metadata_preview: ["camera: X100VI", "date: 2026-02-08"],
    snippet: null
  },
  {
    id: 3,
    path: "/Users/local/Receipts/camera-receipt-copy.jpg",
    filename: "camera-receipt-copy.jpg",
    file_hash: "demo-photo-1",
    kind: "photo",
    mime_type: "image/jpeg",
    size_bytes: 3_420_882,
    created_at: "2026-02-08T18:00:00Z",
    modified_at: "2026-02-08T18:05:00Z",
    imported_at: "2026-07-17T20:57:00Z",
    tag_names: ["duplicate"],
    metadata_preview: ["camera: X100VI", "date: 2026-02-08"],
    snippet: null
  }
];

function tauriAvailable() {
  return isTauri();
}

export async function pickImportFolder(): Promise<string | null> {
  if (!tauriAvailable()) {
    return "/Users/local/Receipts";
  }
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function pickExportPath(defaultName: string): Promise<string | null> {
  if (!tauriAvailable()) {
    return `/Users/local/Desktop/${defaultName}`;
  }
  const selected = await save({ defaultPath: defaultName });
  return typeof selected === "string" ? selected : null;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  if (!tauriAvailable()) {
    return {
      total_files: demoFiles.length,
      total_bytes: demoFiles.reduce((sum, file) => sum + file.size_bytes, 0),
      duplicate_groups: 1,
      duplicate_waste_bytes: 3_420_882,
      documents: 1,
      photos: 2,
      other: 0
    };
  }
  return invoke("dashboard_stats");
}

export function localAssetUrl(path: string): string | null {
  if (!tauriAvailable()) return null;
  return convertFileSrc(path);
}

export async function getFilePreview(fileId: number): Promise<FilePreview> {
  if (!tauriAvailable()) {
    return {
      preview_type: "docx",
      html: "<article><p>This preview is demo content. Real image, PDF, TXT, and DOCX previews are available in the Tauri desktop window.</p></article>"
    };
  }
  return invoke("file_preview", { fileId });
}

export async function searchFiles(query: string, kind: string, duplicateOnly: boolean): Promise<LibraryFile[]> {
  if (!tauriAvailable()) {
    return demoFiles.filter((file) => {
      const text = `${file.filename} ${file.path} ${file.tag_names.join(" ")} ${file.snippet ?? ""}`.toLowerCase();
      const matchesQuery = !query || text.includes(query.toLowerCase());
      const matchesKind = kind === "all" || file.kind === kind;
      const matchesDuplicate = !duplicateOnly || file.file_hash === "demo-photo-1";
      return matchesQuery && matchesKind && matchesDuplicate;
    });
  }
  return invoke("search_files", { query, kind, duplicateOnly });
}

export async function importFolder(path: string): Promise<ImportSummary> {
  if (!tauriAvailable()) {
    return { scanned: 3, indexed: 3, skipped: 0, failed: 0, errors: [] };
  }
  return invoke("import_folder", { path });
}

export async function getDuplicates(): Promise<DuplicateGroup[]> {
  if (!tauriAvailable()) {
    return [
      {
        file_hash: "demo-photo-1",
        total_size_bytes: 6_841_764,
        files: demoFiles.filter((file) => file.file_hash === "demo-photo-1")
      }
    ];
  }
  return invoke("duplicate_groups");
}

export async function addTag(fileId: number, tag: string): Promise<void> {
  if (!tauriAvailable()) return;
  await invoke("add_tag", { fileId, tag });
}

export async function removeTag(fileId: number, tag: string): Promise<void> {
  if (!tauriAvailable()) return;
  await invoke("remove_tag", { fileId, tag });
}

export async function listWatchFolders(): Promise<WatchFolder[]> {
  if (!tauriAvailable()) return [{ id: 1, path: "/Users/local/Receipts", enabled: true, last_scanned_at: null }];
  return invoke("list_watch_folders");
}

export async function addWatchFolder(path: string): Promise<void> {
  if (!tauriAvailable()) return;
  await invoke("add_watch_folder", { path });
}

export async function scanWatchFolders(): Promise<ImportSummary> {
  if (!tauriAvailable()) return { scanned: 3, indexed: 3, skipped: 0, failed: 0, errors: [] };
  return invoke("scan_watch_folders");
}

export async function exportMetadata(path: string): Promise<void> {
  if (!tauriAvailable()) return;
  await invoke("export_metadata", { path });
}

export async function backupDatabase(path: string): Promise<void> {
  if (!tauriAvailable()) return;
  await invoke("backup_database", { path });
}
