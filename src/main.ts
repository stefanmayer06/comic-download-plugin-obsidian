import { apiVersion, normalizePath, Notice, Platform, Plugin, TFile } from "obsidian";
import { log } from "./log";
import { ComicReaderView, READER_EXTENSIONS, VIEW_TYPE_COMIC_READER } from "./reader/ComicReaderView";
import { ComicDownloaderSettings, ComicDownloaderSettingTab, DEFAULT_SETTINGS } from "./settings";
import { GetComicsSource } from "./sources/getComics";
import { InternetArchiveSource } from "./sources/internetArchive";
import type { ComicSource, ComicSummary } from "./sources/types";
import { ComicBrowserModal } from "./ui/ComicBrowserModal";
import { LogModal } from "./ui/LogModal";

export default class ComicDownloaderPlugin extends Plugin {
	settings!: ComicDownloaderSettings;
	sources!: ComicSource[];

	get source(): ComicSource {
		return this.sources.find((source) => source.id === this.settings.sourceId) ?? this.sources[0];
	}

	async onload(): Promise<void> {
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		await log.open(this.app.vault.adapter, normalizePath(`${pluginDir}/debug.log`));
		log.info(`Comic Downloader ${this.manifest.version} started on Obsidian ${apiVersion}, ${platformName()}`);
		await this.loadSettings();
		this.sources = [
			new InternetArchiveSource(() => this.settings),
			new GetComicsSource(() => this.settings),
		];

		this.registerView(VIEW_TYPE_COMIC_READER, (leaf) => new ComicReaderView(leaf, this));
		try {
			// PDFs keep opening in Obsidian's PDF viewer; use "Open in comic reader" for those.
			this.registerExtensions(["cbz"], VIEW_TYPE_COMIC_READER);
		} catch (error) {
			log.warn("Another plugin already opens .cbz files", error);
		}

		this.addRibbonIcon("download", "Download comics", () => new ComicBrowserModal(this).open());
		this.addCommand({
			id: "open-comic-browser",
			name: "Download comics",
			callback: () => new ComicBrowserModal(this).open(),
		});
		this.addCommand({
			id: "show-log",
			name: "Show log",
			callback: () => this.showLog(),
		});
		this.addCommand({
			id: "open-in-comic-reader",
			name: "Open current file in comic reader",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !READER_EXTENSIONS.includes(file.extension)) return false;
				if (!checking) void this.openInReader(file);
				return true;
			},
		});
		this.addCommand({
			id: "next-page",
			name: "Next page",
			checkCallback: (checking) => this.withActiveReader(checking, (reader) => reader.turn(true)),
		});
		this.addCommand({
			id: "previous-page",
			name: "Previous page",
			checkCallback: (checking) => this.withActiveReader(checking, (reader) => reader.turn(false)),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !READER_EXTENSIONS.includes(file.extension)) return;
				menu.addItem((item) =>
					item
						.setTitle("Open in comic reader")
						.setIcon("book-open")
						.onClick(() => this.openInReader(file)),
				);
			}),
		);
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onPathChanged(oldPath, file.path)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onPathChanged(file.path, null)));

		this.addSettingTab(new ComicDownloaderSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.downloads = { ...this.settings.downloads };
		this.settings.progress = { ...this.settings.progress };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async openInReader(file: TFile): Promise<void> {
		if (!READER_EXTENSIONS.includes(file.extension)) {
			new Notice(`The comic reader can't open .${file.extension} files yet.`);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_COMIC_READER, state: { file: file.path }, active: true });
	}

	showLog(): void {
		new LogModal(this.app).open();
	}

	refreshReaders(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMIC_READER)) {
			if (leaf.view instanceof ComicReaderView) leaf.view.applySettings();
		}
	}

	/** Files already downloaded for a search result that are still in the vault. */
	downloadedFiles(comic: ComicSummary): TFile[] {
		const paths = this.settings.downloads[downloadKey(comic)] ?? [];
		return paths
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile);
	}

	async recordDownload(comic: ComicSummary, path: string): Promise<void> {
		const key = downloadKey(comic);
		const paths = this.settings.downloads[key] ?? [];
		if (!paths.includes(path)) this.settings.downloads[key] = [...paths, path];
		await this.saveSettings();
	}

	private withActiveReader(checking: boolean, action: (reader: ComicReaderView) => void): boolean {
		const reader = this.app.workspace.getActiveViewOfType(ComicReaderView);
		if (!reader) return false;
		if (!checking) action(reader);
		return true;
	}

	/**
	 * Keeps download records and reading progress attached to files when they
	 * (or a folder holding them) are renamed, moved or deleted.
	 */
	private onPathChanged(oldPath: string, newPath: string | null): void {
		const remap = (path: string): string | null | undefined => {
			if (path === oldPath) return newPath;
			if (path.startsWith(`${oldPath}/`)) return newPath && newPath + path.slice(oldPath.length);
			return undefined;
		};
		let changed = false;

		for (const [key, paths] of Object.entries(this.settings.downloads)) {
			const updated = paths.map((path) => {
				const mapped = remap(path);
				return mapped === undefined ? path : mapped;
			});
			if (updated.every((path, i) => path === paths[i])) continue;
			const kept = updated.filter((path): path is string => path !== null);
			if (kept.length > 0) this.settings.downloads[key] = kept;
			else delete this.settings.downloads[key];
			changed = true;
		}
		for (const [path, page] of Object.entries(this.settings.progress)) {
			const mapped = remap(path);
			if (mapped === undefined) continue;
			delete this.settings.progress[path];
			if (mapped) this.settings.progress[mapped] = page;
			changed = true;
		}
		if (changed) void this.saveSettings();
	}
}

function downloadKey(comic: ComicSummary): string {
	return `${comic.sourceId}:${comic.id}`;
}

function platformName(): string {
	if (Platform.isAndroidApp) return "Android";
	if (Platform.isIosApp) return Platform.isTablet ? "iPadOS" : "iOS";
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return "unknown platform";
}
