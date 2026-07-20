import {
  Archive,
  BadgeCheck,
  BellOff,
  Camera,
  CalendarDays,
  CheckCircle2,
  Database,
  Download,
  Eye,
  FileSearch,
  FolderInput,
  FolderSync,
  HardDrive,
  ListFilter,
  Lock,
  Plus,
  Search,
  Settings,
  Shield,
  Tags,
  UserRound,
  Trash2
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  addTag,
  addWatchFolder,
  backupDatabase,
  exportMetadata,
  getFilePreview,
  getDashboardStats,
  getDuplicates,
  importFolder,
  listWatchFolders,
  localAssetUrl,
  pickExportPath,
  pickImportFolder,
  removeTag,
  scanWatchFolders,
  searchFiles
} from "./tauri";
import type {
  DashboardStats,
  DuplicateGroup,
  FilePreview,
  ImportSummary,
  LibraryFile,
  SearchFilters,
  TimelineCategory,
  TimelineGroup,
  WatchFolder
} from "./types";

type Screen = "library" | "timeline" | "search" | "duplicates" | "imports" | "settings";

const navItems: Array<{ id: Screen; label: string; icon: typeof FileSearch }> = [
  { id: "library", label: "Library", icon: FileSearch },
  { id: "timeline", label: "Timeline", icon: CalendarDays },
  { id: "search", label: "Search", icon: Search },
  { id: "duplicates", label: "Duplicates", icon: Archive },
  { id: "imports", label: "Imports", icon: FolderInput },
  { id: "settings", label: "Settings", icon: Settings }
];

const byteFormatter = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${byteFormatter.format(size)} ${unit}`;
}

function formatDate(value?: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function App() {
  const [screen, setScreen] = useState<Screen>("library");
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [watchFolders, setWatchFolders] = useState<WatchFolder[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({ query: "", kind: "all", duplicateOnly: false });
  const [selectedFile, setSelectedFile] = useState<LibraryFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Local-only mode is on. Files are indexed in place.");
  const [lastImport, setLastImport] = useState<ImportSummary | null>(null);

  async function refresh(nextFilters = filters) {
    const [nextFiles, nextStats, nextDuplicates, nextWatchFolders] = await Promise.all([
      searchFiles(nextFilters.query, nextFilters.kind, nextFilters.duplicateOnly),
      getDashboardStats(),
      getDuplicates(),
      listWatchFolders()
    ]);
    setFiles(nextFiles);
    setStats(nextStats);
    setDuplicates(nextDuplicates);
    setWatchFolders(nextWatchFolders);
    if (!selectedFile && nextFiles.length > 0) setSelectedFile(nextFiles[0]);
  }

  useEffect(() => {
    refresh().catch((error) => setNotice(String(error)));
  }, []);

  async function runImport() {
    const path = await pickImportFolder();
    if (!path) return;
    setBusy(true);
    setNotice(`Scanning ${path}`);
    try {
      const summary = await importFolder(path);
      setLastImport(summary);
      setNotice(`Indexed ${summary.indexed} files. Skipped ${summary.skipped}. Failed ${summary.failed}.`);
      await refresh();
      setScreen("library");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(nextFilters: SearchFilters) {
    setFilters(nextFilters);
    const nextFiles = await searchFiles(nextFilters.query, nextFilters.kind, nextFilters.duplicateOnly);
    setFiles(nextFiles);
    if (nextFiles[0]) setSelectedFile(nextFiles[0]);
  }

  async function runAddWatchFolder() {
    const path = await pickImportFolder();
    if (!path) return;
    await addWatchFolder(path);
    setNotice(`Watching ${path}`);
    await refresh();
  }

  async function runScanWatchFolders() {
    setBusy(true);
    try {
      const summary = await scanWatchFolders();
      setLastImport(summary);
      setNotice(`Watched folders scanned. Indexed ${summary.indexed} files.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runExportMetadata() {
    const path = await pickExportPath("private-file-organizer-metadata.csv");
    if (!path) return;
    await exportMetadata(path);
    setNotice(`Metadata exported to ${path}`);
  }

  async function runBackupDatabase() {
    const path = await pickExportPath("private-file-organizer-backup.sqlite");
    if (!path) return;
    await backupDatabase(path);
    setNotice(`Database backup saved to ${path}`);
  }

  async function tagSelected(tag: string) {
    if (!selectedFile || !tag.trim()) return;
    await addTag(selectedFile.id, tag.trim());
    setNotice(`Tagged ${selectedFile.filename} as ${tag.trim()}`);
    await refresh();
  }

  async function tagRemoved(tag: string) {
    if (!selectedFile) return;
    await removeTag(selectedFile.id, tag);
    setNotice(`Removed ${tag} from ${selectedFile.filename}`);
    await refresh();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Shield size={22} /></div>
          <div>
            <strong>Private Organizer</strong>
            <span>Local library</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={screen === item.id ? "active" : ""} onClick={() => setScreen(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="privacy-panel">
          <Lock size={18} />
          <div>
            <strong>Everything stays on this device</strong>
            <span>No account. No upload by default. Telemetry disabled.</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{navItems.find((item) => item.id === screen)?.label}</h1>
            <p>{notice}</p>
          </div>
          <div className="topbar-actions">
            <button className="secondary" onClick={runExportMetadata}>
              <Download size={17} /> Export
            </button>
            <button className="primary" onClick={runImport} disabled={busy}>
              <FolderInput size={17} /> Import Folder
            </button>
          </div>
        </header>

        {stats && <StatsStrip stats={stats} />}

        {screen === "library" && (
          <LibraryScreen
            files={files}
            selectedFile={selectedFile}
            setSelectedFile={setSelectedFile}
            filters={filters}
            runSearch={runSearch}
            tagSelected={tagSelected}
            tagRemoved={tagRemoved}
          />
        )}
        {screen === "timeline" && (
          <TimelineScreen files={files} selectedFile={selectedFile} setSelectedFile={setSelectedFile} tagSelected={tagSelected} tagRemoved={tagRemoved} />
        )}
        {screen === "search" && (
          <SearchScreen files={files} filters={filters} runSearch={runSearch} selectedFile={selectedFile} setSelectedFile={setSelectedFile} />
        )}
        {screen === "duplicates" && <DuplicatesScreen groups={duplicates} />}
        {screen === "imports" && (
          <ImportsScreen
            watchFolders={watchFolders}
            lastImport={lastImport}
            busy={busy}
            runAddWatchFolder={runAddWatchFolder}
            runScanWatchFolders={runScanWatchFolders}
          />
        )}
        {screen === "settings" && <SettingsScreen runBackupDatabase={runBackupDatabase} />}
      </main>
    </div>
  );
}

function StatsStrip({ stats }: { stats: DashboardStats }) {
  return (
    <section className="stats-strip">
      <Metric icon={Database} label="Indexed" value={stats.total_files.toLocaleString()} />
      <Metric icon={HardDrive} label="Library size" value={formatBytes(stats.total_bytes)} />
      <Metric icon={Camera} label="Photos" value={stats.photos.toLocaleString()} />
      <Metric icon={FileSearch} label="Documents" value={stats.documents.toLocaleString()} />
      <Metric icon={Archive} label="Duplicate groups" value={stats.duplicate_groups.toLocaleString()} />
      <Metric icon={Trash2} label="Recoverable" value={formatBytes(stats.duplicate_waste_bytes)} />
    </section>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Database; label: string; value: string }) {
  return (
    <div className="metric">
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function FilterBar({ filters, runSearch }: { filters: SearchFilters; runSearch: (filters: SearchFilters) => Promise<void> }) {
  return (
    <div className="filter-bar">
      <label className="search-box">
        <Search size={18} />
        <input
          value={filters.query}
          placeholder="Search filenames, tags, document text, metadata"
          onChange={(event) => runSearch({ ...filters, query: event.target.value })}
        />
      </label>
      <select value={filters.kind} onChange={(event) => runSearch({ ...filters, kind: event.target.value })}>
        <option value="all">All types</option>
        <option value="document">Documents</option>
        <option value="photo">Photos</option>
        <option value="text">Text</option>
        <option value="other">Other</option>
      </select>
      <button className={filters.duplicateOnly ? "toggle active" : "toggle"} onClick={() => runSearch({ ...filters, duplicateOnly: !filters.duplicateOnly })}>
        <ListFilter size={16} /> Duplicates
      </button>
    </div>
  );
}

function LibraryScreen(props: {
  files: LibraryFile[];
  selectedFile: LibraryFile | null;
  setSelectedFile: (file: LibraryFile) => void;
  filters: SearchFilters;
  runSearch: (filters: SearchFilters) => Promise<void>;
  tagSelected: (tag: string) => Promise<void>;
  tagRemoved: (tag: string) => Promise<void>;
}) {
  return (
    <section className="split-view">
      <div className="library-pane">
        <FilterBar filters={props.filters} runSearch={props.runSearch} />
        <FileTable files={props.files} selectedFile={props.selectedFile} setSelectedFile={props.setSelectedFile} />
      </div>
      <PreviewPanel file={props.selectedFile} tagSelected={props.tagSelected} tagRemoved={props.tagRemoved} />
    </section>
  );
}

function SearchScreen(props: {
  files: LibraryFile[];
  filters: SearchFilters;
  runSearch: (filters: SearchFilters) => Promise<void>;
  selectedFile: LibraryFile | null;
  setSelectedFile: (file: LibraryFile) => void;
}) {
  return (
    <section className="single-view">
      <FilterBar filters={props.filters} runSearch={props.runSearch} />
      <FileTable files={props.files} selectedFile={props.selectedFile} setSelectedFile={props.setSelectedFile} />
    </section>
  );
}

const timelineCategories: Array<{ id: TimelineCategory | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "client", label: "Clients" },
  { id: "project", label: "Projects" },
  { id: "tax", label: "Tax Years" },
  { id: "trip", label: "Trips" },
  { id: "purchase", label: "Purchases" },
  { id: "case", label: "Cases" },
  { id: "life", label: "Life Events" },
  { id: "date", label: "By Date" }
];

function TimelineScreen({
  files,
  selectedFile,
  setSelectedFile,
  tagSelected,
  tagRemoved
}: {
  files: LibraryFile[];
  selectedFile: LibraryFile | null;
  setSelectedFile: (file: LibraryFile) => void;
  tagSelected: (tag: string) => Promise<void>;
  tagRemoved: (tag: string) => Promise<void>;
}) {
  const [category, setCategory] = useState<TimelineCategory | "all">("all");
  const groups = useMemo(() => buildTimelineGroups(files), [files]);
  const visibleGroups = category === "all" ? groups : groups.filter((group) => group.category === category);

  return (
    <section className="split-view timeline-view">
      <div className="timeline-pane">
        <div className="timeline-header">
          <div>
            <h2>Timeline organization</h2>
            <p>Files are grouped by inferred events, clients, projects, tax years, trips, purchases, and cases.</p>
          </div>
          <div className="category-tabs" role="tablist" aria-label="Timeline category filters">
            {timelineCategories.map((item) => (
              <button
                key={item.id}
                className={category === item.id ? "active" : ""}
                onClick={() => setCategory(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="timeline-list">
          {visibleGroups.map((group) => (
            <TimelineGroupCard
              key={group.id}
              group={group}
              selectedFile={selectedFile}
              setSelectedFile={setSelectedFile}
            />
          ))}
          {visibleGroups.length === 0 && <div className="empty-state">Import files or add tags like client, project, tax, trip, purchase, or case to build timeline groups.</div>}
        </div>
      </div>
      <PreviewPanel file={selectedFile} tagSelected={tagSelected} tagRemoved={tagRemoved} />
    </section>
  );
}

function TimelineGroupCard({
  group,
  selectedFile,
  setSelectedFile
}: {
  group: TimelineGroup;
  selectedFile: LibraryFile | null;
  setSelectedFile: (file: LibraryFile) => void;
}) {
  return (
    <article className={`timeline-card ${group.category}`}>
      <div className="timeline-marker">
        <TimelineCategoryIcon category={group.category} />
      </div>
      <div className="timeline-card-body">
        <header>
          <div>
            <span className="timeline-date">{group.dateLabel}</span>
            <h3>{group.title}</h3>
          </div>
          <div className="timeline-summary">
            <strong>{group.files.length}</strong>
            <span>{formatBytes(group.totalBytes)}</span>
          </div>
        </header>
        <div className="timeline-evidence">
          <em>{categoryLabel(group.category)}</em>
          {group.evidence.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
        </div>
        <div className="timeline-files">
          {group.files.slice(0, 8).map((file) => (
            <button
              key={file.id}
              className={selectedFile?.id === file.id ? "active" : ""}
              onClick={() => setSelectedFile(file)}
            >
              <FileIcon kind={file.kind} />
              <span>
                <strong>{file.filename}</strong>
                <small>{formatDate(file.modified_at ?? file.created_at)} · {file.kind}</small>
              </span>
            </button>
          ))}
          {group.files.length > 8 && <div className="timeline-more">{group.files.length - 8} more files in this group</div>}
        </div>
      </div>
    </article>
  );
}

function TimelineCategoryIcon({ category }: { category: TimelineCategory }) {
  if (category === "client") return <UserRound size={18} />;
  if (category === "project") return <FolderSync size={18} />;
  if (category === "tax") return <Database size={18} />;
  if (category === "trip") return <Camera size={18} />;
  if (category === "purchase") return <Archive size={18} />;
  if (category === "case") return <Shield size={18} />;
  if (category === "life") return <Tags size={18} />;
  return <CalendarDays size={18} />;
}

function categoryLabel(category: TimelineCategory) {
  return {
    client: "Client",
    project: "Project",
    tax: "Tax year",
    trip: "Trip",
    purchase: "Purchase",
    case: "Case",
    life: "Life event",
    date: "Date group"
  }[category];
}

function buildTimelineGroups(files: LibraryFile[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();

  for (const file of files) {
    const inference = inferTimelineGroup(file);
    const key = `${inference.category}:${inference.title.toLowerCase()}`;
    const sortDate = fileDateValue(file);
    const existing = groups.get(key);
    if (existing) {
      existing.files.push(file);
      existing.totalBytes += file.size_bytes;
      existing.sortDate = Math.max(existing.sortDate, sortDate);
      existing.dateLabel = labelDate(existing.sortDate);
      inference.evidence.forEach((item) => {
        if (!existing.evidence.includes(item)) existing.evidence.push(item);
      });
    } else {
      groups.set(key, {
        id: key.replace(/[^a-z0-9:.-]+/gi, "-"),
        title: inference.title,
        category: inference.category,
        dateLabel: labelDate(sortDate),
        sortDate,
        files: [file],
        evidence: inference.evidence,
        totalBytes: file.size_bytes
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      files: group.files.sort((a, b) => fileDateValue(b) - fileDateValue(a))
    }))
    .sort((a, b) => b.sortDate - a.sortDate || priorityForCategory(a.category) - priorityForCategory(b.category));
}

function inferTimelineGroup(file: LibraryFile): { title: string; category: TimelineCategory; evidence: string[] } {
  const tags = file.tag_names.map((tag) => tag.toLowerCase());
  const pathParts = splitPathParts(file.path);
  const text = `${file.filename} ${file.path} ${file.tag_names.join(" ")} ${file.metadata_preview.join(" ")}`.toLowerCase();
  const taxYear = extractTaxYear(text, file);

  if (taxYear && hasAny(text, ["tax", "1040", "w2", "w-2", "1099", "irs", "deduction", "receipt", "invoice"])) {
    return {
      title: `Tax Year ${taxYear}`,
      category: "tax",
      evidence: compactEvidence(["tax keyword", matchingTag(tags, ["tax", "1099", "w2", "receipt"])])
    };
  }

  if (hasAny(text, ["case", "legal", "matter", "docket", "court", "claim", "settlement"])) {
    const name = pickNamedSegment(pathParts, ["cases", "case", "matters", "legal"]) ?? usefulTag(tags) ?? titleFromFile(file);
    return {
      title: `Case: ${cleanTitle(name)}`,
      category: "case",
      evidence: compactEvidence(["case/legal keyword", sourceHint(file)])
    };
  }

  if (hasAny(text, ["client", "contract", "proposal", "statement of work", "sow", "retainer"]) || pathHas(pathParts, ["clients", "client"])) {
    const name = pickNamedSegment(pathParts, ["clients", "client"]) ?? usefulTag(tags) ?? titleFromFile(file);
    return {
      title: `Client: ${cleanTitle(name)}`,
      category: "client",
      evidence: compactEvidence(["client/contract keyword", sourceHint(file)])
    };
  }

  if (hasAny(text, ["project", "brief", "milestone", "deliverable", "assets"]) || pathHas(pathParts, ["projects", "project"])) {
    const name = pickNamedSegment(pathParts, ["projects", "project"]) ?? usefulTag(tags) ?? titleFromFile(file);
    return {
      title: `Project: ${cleanTitle(name)}`,
      category: "project",
      evidence: compactEvidence(["project keyword", sourceHint(file)])
    };
  }

  if (hasAny(text, ["trip", "travel", "vacation", "flight", "hotel", "airbnb", "booking", "itinerary", "passport"])) {
    const name = pickNamedSegment(pathParts, ["trips", "trip", "travel", "vacations", "vacation"]) ?? usefulTag(tags) ?? titleFromFile(file);
    return {
      title: `Trip: ${cleanTitle(name)}`,
      category: "trip",
      evidence: compactEvidence(["travel keyword", sourceHint(file)])
    };
  }

  if (hasAny(text, ["purchase", "receipt", "invoice", "warranty", "order", "return", "quote", "estimate"])) {
    const name = usefulTag(tags) ?? pickLikelyFolder(pathParts) ?? titleFromFile(file);
    return {
      title: `Purchase: ${cleanTitle(name)}`,
      category: "purchase",
      evidence: compactEvidence(["purchase/receipt keyword", matchingTag(tags, ["receipt", "invoice", "warranty", "purchase"])])
    };
  }

  if (hasAny(text, ["family", "medical", "school", "home", "house", "insurance", "car", "wedding", "birth", "passport", "lease"])) {
    const name = usefulTag(tags) ?? pickLikelyFolder(pathParts) ?? titleFromFile(file);
    return {
      title: `Life Event: ${cleanTitle(name)}`,
      category: "life",
      evidence: compactEvidence(["life-event keyword", sourceHint(file)])
    };
  }

  const date = new Date(fileDateValue(file));
  const month = date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
  return {
    title: month,
    category: "date",
    evidence: compactEvidence(["date fallback", sourceHint(file)])
  };
}

function fileDateValue(file: LibraryFile) {
  const date = new Date(file.modified_at ?? file.created_at ?? file.imported_at);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function labelDate(value: number) {
  if (!value) return "Unknown date";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function priorityForCategory(category: TimelineCategory) {
  return ["case", "client", "project", "tax", "trip", "purchase", "life", "date"].indexOf(category);
}

function splitPathParts(path: string) {
  return path.split(/[\\/]+/).filter(Boolean);
}

function pathHas(parts: string[], markers: string[]) {
  const markerSet = new Set(markers);
  return parts.some((part) => markerSet.has(part.toLowerCase()));
}

function pickNamedSegment(parts: string[], markers: string[]) {
  const markerSet = new Set(markers);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (markerSet.has(parts[index].toLowerCase())) return parts[index + 1];
  }
  return null;
}

function pickLikelyFolder(parts: string[]) {
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

function hasAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function matchingTag(tags: string[], needles: string[]) {
  return tags.find((tag) => needles.some((needle) => tag.includes(needle))) ? "manual tag" : null;
}

function usefulTag(tags: string[]) {
  const generic = new Set(["receipt", "invoice", "tax", "client", "project", "case", "trip", "purchase", "document", "photo", "duplicate"]);
  return tags.find((tag) => !generic.has(tag));
}

function sourceHint(file: LibraryFile) {
  const source = file.metadata_preview.find((item) => item.toLowerCase().startsWith("source_folder:"));
  if (source) return "source folder";
  return file.path ? "path" : null;
}

function compactEvidence(values: Array<string | null | undefined>) {
  return values.filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
}

function extractTaxYear(text: string, file: LibraryFile) {
  const explicit = text.match(/\b(20\d{2}|19\d{2})\b/);
  if (explicit) return explicit[1];
  const date = new Date(file.modified_at ?? file.created_at ?? file.imported_at);
  return Number.isNaN(date.getTime()) ? null : String(date.getFullYear());
}

function titleFromFile(file: LibraryFile) {
  return file.filename.replace(/\.[^.]+$/, "");
}

function cleanTitle(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function FileTable({ files, selectedFile, setSelectedFile }: { files: LibraryFile[]; selectedFile: LibraryFile | null; setSelectedFile: (file: LibraryFile) => void }) {
  return (
    <div className="file-table" role="table">
      <div className="file-row header" role="row">
        <span>Name</span>
        <span>Type</span>
        <span>Size</span>
        <span>Date</span>
        <span>Tags</span>
      </div>
      {files.map((file) => (
        <button key={file.id} className={selectedFile?.id === file.id ? "file-row selected" : "file-row"} onClick={() => setSelectedFile(file)}>
          <span className="name-cell">
            <FileIcon kind={file.kind} />
            <span>
              <strong>{file.filename}</strong>
              <small>{file.path}</small>
            </span>
          </span>
          <span>{file.kind}</span>
          <span>{formatBytes(file.size_bytes)}</span>
          <span>{formatDate(file.modified_at ?? file.created_at)}</span>
          <span className="tag-list">{file.tag_names.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}</span>
        </button>
      ))}
      {files.length === 0 && <div className="empty-state">Import a folder to build the local index.</div>}
    </div>
  );
}

function FileIcon({ kind }: { kind: string }) {
  if (kind === "photo") return <Camera size={18} />;
  if (kind === "document" || kind === "text") return <FileSearch size={18} />;
  return <HardDrive size={18} />;
}

function PreviewPanel({
  file,
  tagSelected,
  tagRemoved
}: {
  file: LibraryFile | null;
  tagSelected: (tag: string) => Promise<void>;
  tagRemoved: (tag: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [draftTag, setDraftTag] = useState("");

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    if (!file) return;
    getFilePreview(file.id)
      .then((nextPreview) => {
        if (!cancelled) setPreview(nextPreview);
      })
      .catch((error) => {
        if (!cancelled) setPreviewError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [file?.id]);

  async function submitTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftTag.trim()) return;
    await tagSelected(draftTag);
    setDraftTag("");
  }

  if (!file) return <aside className="preview-panel empty">Select a file to inspect local metadata.</aside>;
  return (
    <aside className="preview-panel">
      <FilePreviewPane file={file} preview={preview} error={previewError} />
      <h2>{file.filename}</h2>
      <p className="path">{file.path}</p>
      <div className="detail-grid">
        <span>Kind</span><strong>{file.kind}</strong>
        <span>MIME</span><strong>{file.mime_type}</strong>
        <span>Size</span><strong>{formatBytes(file.size_bytes)}</strong>
        <span>Modified</span><strong>{formatDate(file.modified_at)}</strong>
        <span>SHA-256</span><strong className="hash">{file.file_hash}</strong>
      </div>
      {file.snippet && <blockquote>{file.snippet}</blockquote>}
      <form className="inline-tag-editor" onSubmit={submitTag}>
        <label>
          <Tags size={16} />
          <input value={draftTag} onChange={(event) => setDraftTag(event.target.value)} placeholder="Add tag" />
        </label>
        <button className="secondary" disabled={!draftTag.trim()}><Plus size={16} /> Add</button>
      </form>
      <div className="selected-tags">
        {file.tag_names.map((tag) => (
          <span key={tag}>
            {tag}
            <button type="button" onClick={() => tagRemoved(tag)} aria-label={`Remove ${tag} tag`}>x</button>
          </span>
        ))}
        {file.tag_names.length === 0 && <em>No tags yet</em>}
      </div>
      <div className="metadata-list">
        {file.metadata_preview.map((item) => <span key={item}>{item}</span>)}
      </div>
      <div className="safe-actions">
        <button><Eye size={16} /> Preview</button>
        <button><Archive size={16} /> Copy organized</button>
      </div>
    </aside>
  );
}

function FilePreviewPane({ file, preview, error }: { file: LibraryFile; preview: FilePreview | null; error: string | null }) {
  const assetUrl = localAssetUrl(file.path);
  const extension = file.filename.split(".").pop()?.toLowerCase() ?? "";

  if (error) {
    return (
      <div className="preview-visual preview-message">
        <FileIcon kind={file.kind} />
        <span>{error}</span>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="preview-visual preview-message">
        <FileIcon kind={file.kind} />
        <span>Loading preview</span>
      </div>
    );
  }

  if (extension === "heic") {
    return (
      <div className="preview-visual preview-message">
        <Camera size={42} />
        <span>HEIC is indexed. Native preview support depends on the webview.</span>
      </div>
    );
  }

  if (preview.preview_type === "image" && assetUrl) {
    return (
      <div className="file-render image-render">
        <img src={assetUrl} alt={file.filename} />
      </div>
    );
  }

  if (preview.preview_type === "pdf" && assetUrl) {
    return (
      <div className="file-render pdf-render">
        <iframe title={`${file.filename} preview`} src={assetUrl} />
      </div>
    );
  }

  if (preview.preview_type === "docx" && preview.html) {
    return (
      <div className="file-render doc-render">
        <div className="doc-page" dangerouslySetInnerHTML={{ __html: preview.html }} />
      </div>
    );
  }

  if (preview.preview_type === "text" && preview.text) {
    return (
      <div className="file-render text-render">
        <pre>{preview.text}</pre>
      </div>
    );
  }

  return (
    <div className="preview-visual preview-message">
      <FileIcon kind={file.kind} />
      <span>{preview.message ?? "No preview available for this file."}</span>
    </div>
  );
}

function DuplicatesScreen({ groups }: { groups: DuplicateGroup[] }) {
  return (
    <section className="single-view">
      <div className="section-toolbar">
        <div>
          <h2>Exact duplicates</h2>
          <p>Files are grouped by SHA-256 hash. No delete or move happens without confirmation.</p>
        </div>
        <button className="secondary"><Archive size={17} /> Copy keepers</button>
      </div>
      <div className="duplicate-groups">
        {groups.map((group) => (
          <article className="duplicate-group" key={group.file_hash}>
            <header>
              <strong>{group.files.length} matching files</strong>
              <span>{formatBytes(group.total_size_bytes)} total</span>
            </header>
            {group.files.map((file) => (
              <div className="duplicate-file" key={file.id}>
                <CheckCircle2 size={17} />
                <span>{file.path}</span>
                <button><Eye size={15} /> Inspect</button>
              </div>
            ))}
          </article>
        ))}
        {groups.length === 0 && <div className="empty-state">No exact duplicates found yet.</div>}
      </div>
    </section>
  );
}

function ImportsScreen(props: {
  watchFolders: WatchFolder[];
  lastImport: ImportSummary | null;
  busy: boolean;
  runAddWatchFolder: () => Promise<void>;
  runScanWatchFolders: () => Promise<void>;
}) {
  return (
    <section className="single-view">
      <div className="section-toolbar">
        <div>
          <h2>Watched folders</h2>
          <p>Folders are indexed in place. New files can be scanned without copying private data.</p>
        </div>
        <div className="inline-actions">
          <button className="secondary" onClick={props.runScanWatchFolders} disabled={props.busy}><FolderSync size={17} /> Scan</button>
          <button className="primary" onClick={props.runAddWatchFolder}><Plus size={17} /> Add Watch</button>
        </div>
      </div>
      <div className="watch-list">
        {props.watchFolders.map((folder) => (
          <article className="watch-folder" key={folder.id}>
            <FolderSync size={18} />
            <div>
              <strong>{folder.path}</strong>
              <span>{folder.enabled ? "Enabled" : "Paused"} · Last scanned {formatDate(folder.last_scanned_at)}</span>
            </div>
          </article>
        ))}
      </div>
      {props.lastImport && (
        <div className="import-summary">
          <strong>Last scan</strong>
          <span>{props.lastImport.scanned} scanned</span>
          <span>{props.lastImport.indexed} indexed</span>
          <span>{props.lastImport.skipped} skipped</span>
          <span>{props.lastImport.failed} failed</span>
        </div>
      )}
    </section>
  );
}

function SettingsScreen({ runBackupDatabase }: { runBackupDatabase: () => Promise<void> }) {
  return (
    <section className="settings-grid">
      <article>
        <Shield size={20} />
        <h2>Privacy</h2>
        <label><input type="checkbox" checked readOnly /> Local-only mode</label>
        <label><input type="checkbox" checked readOnly /> Telemetry disabled</label>
        <label><input type="checkbox" readOnly /> Encrypted index beta</label>
      </article>
      <article>
        <Database size={20} />
        <h2>Database</h2>
        <p>SQLite stores file paths, hashes, tags, dates, extracted text, and metadata. Original files remain where they are.</p>
        <button className="secondary" onClick={runBackupDatabase}><Download size={17} /> Backup database</button>
      </article>
      <article>
        <BadgeCheck size={20} />
        <h2>License</h2>
        <p>Free indexes up to 2,000 files. Paid unlocks unlimited library, duplicate cleanup, OCR, batch rename, smart folders, and encrypted backup.</p>
        <button className="secondary">Enter license key</button>
      </article>
      <article>
        <BellOff size={20} />
        <h2>Network</h2>
        <p>No account is required. Cloud sync and telemetry are off by default and are not used by this MVP.</p>
      </article>
    </section>
  );
}
