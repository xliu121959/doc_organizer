export type LibraryFile = {
  id: number;
  path: string;
  filename: string;
  file_hash: string;
  perceptual_hash?: string | null;
  kind: string;
  mime_type: string;
  size_bytes: number;
  created_at?: string | null;
  modified_at?: string | null;
  imported_at: string;
  tag_names: string[];
  metadata_preview: string[];
  snippet?: string | null;
};

export type ImportSummary = {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  errors: string[];
};

export type DuplicateGroup = {
  file_hash: string;
  total_size_bytes: number;
  files: LibraryFile[];
};

export type DashboardStats = {
  total_files: number;
  total_bytes: number;
  duplicate_groups: number;
  duplicate_waste_bytes: number;
  documents: number;
  photos: number;
  other: number;
};

export type WatchFolder = {
  id: number;
  path: string;
  enabled: boolean;
  last_scanned_at?: string | null;
};

export type SearchFilters = {
  query: string;
  kind: string;
  duplicateOnly: boolean;
};

export type FilePreview = {
  preview_type: "image" | "pdf" | "docx" | "text" | "unsupported";
  html?: string | null;
  text?: string | null;
  message?: string | null;
};

export type TimelineCategory = "life" | "project" | "client" | "tax" | "trip" | "purchase" | "case" | "date";

export type TimelineGroup = {
  id: string;
  title: string;
  category: TimelineCategory;
  dateLabel: string;
  sortDate: number;
  files: LibraryFile[];
  evidence: string[];
  totalBytes: number;
};
