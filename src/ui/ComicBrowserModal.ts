import { ButtonComponent, DropdownComponent, Modal, TFile } from "obsidian";
import { comicPath } from "../downloader";
import { log } from "../log";
import type ComicDownloaderPlugin from "../main";
import type { BrowserTab } from "../settings";
import { ComicFile, ComicSource, ComicSummary, filterValue, FilterValues } from "../sources/types";
import { errorMessage } from "../util";
import { createCard } from "./card";
import { FilePickerModal } from "./FilePickerModal";
import { InstalledView } from "./InstalledView";
import { showErrorNotice } from "./notices";

const TABS: { id: BrowserTab; label: string }[] = [
	{ id: "browse", label: "Browse" },
	{ id: "installed", label: "Installed" },
];

/**
 * The download menu, with two pages picked side by side at the top:
 *
 * - Browse: a search box and source, publisher, type and sort pickers over
 *   a scrolling list of comic cards. Each card shows name, author,
 *   publisher and description, a download button and the cover.
 * - Installed: the downloaded comics (see InstalledView).
 *
 * Downloads run in the plugin's queue, so the menu can be closed while they continue.
 */
export class ComicBrowserModal extends Modal {
	private tab: BrowserTab;
	private source: ComicSource;
	private query = "";
	/** The page "Load more" (or "Try again") fetches next. */
	private nextPage = 1;
	/** Guards against an older search finishing after a newer one. */
	private searchToken = 0;
	private filesCache = new Map<string, ComicFile[]>();
	/** Updates the button of each card shown, e.g. as a download progresses. */
	private cardRefreshers: (() => void)[] = [];
	private stopWatchingDownloads: (() => void) | null = null;
	/** Browse searches when it is first shown, not when the menu opens on Installed. */
	private searched = false;

	private tabButtons = new Map<BrowserTab, HTMLButtonElement>();
	private pages = new Map<BrowserTab, HTMLElement>();
	private installed!: InstalledView;
	private inputEl!: HTMLInputElement;
	private filtersEl!: HTMLElement;
	private sourceDescriptionEl!: HTMLElement;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private moreButton!: ButtonComponent;

	constructor(
		private plugin: ComicDownloaderPlugin,
		tab?: BrowserTab,
	) {
		super(plugin.app);
		this.source = plugin.source;
		this.tab = tab ?? plugin.settings.browserTab;
	}

	onOpen(): void {
		this.plugin.browser = this;
		this.stopWatchingDownloads = this.plugin.downloads.onChange(() => this.cardRefreshers.forEach((refresh) => refresh()));
		this.modalEl.addClass("comic-browser-modal");
		this.titleEl.setText("Comics");
		const { contentEl } = this;

		const tabsEl = contentEl.createDiv({ cls: "comic-browser-tabs", attr: { role: "tablist" } });
		for (const { id, label } of TABS) {
			const button = tabsEl.createEl("button", { text: label, cls: "comic-browser-tab", attr: { role: "tab" } });
			button.addEventListener("click", () => void this.showTab(id));
			this.tabButtons.set(id, button);
			this.pages.set(id, contentEl.createDiv({ cls: "comic-browser-page" }));
		}
		this.buildBrowsePage(this.pages.get("browse")!);
		this.installed = new InstalledView(this.plugin, this.pages.get("installed")!, () => this.close());
		void this.showTab(this.tab);
	}

	onClose(): void {
		if (this.plugin.browser === this) this.plugin.browser = null;
		this.stopWatchingDownloads?.();
		this.installed?.destroy();
		this.cardRefreshers = [];
		this.searchToken++;
		this.contentEl.empty();
	}

	async showTab(tab: BrowserTab): Promise<void> {
		this.tab = tab;
		for (const [id, button] of this.tabButtons) {
			button.toggleClass("is-active", id === tab);
			button.setAttribute("aria-selected", String(id === tab));
			this.pages.get(id)?.toggle(id === tab);
		}
		if (tab === "installed") {
			this.installed.render();
		} else if (!this.searched) {
			this.startSearch("");
			this.inputEl.focus();
		}
		if (this.plugin.settings.browserTab !== tab) {
			this.plugin.settings.browserTab = tab;
			await this.plugin.saveSettings();
		}
	}

	private buildBrowsePage(pageEl: HTMLElement): void {
		const form = pageEl.createEl("form", { cls: "comic-browser-search" });
		this.inputEl = form.createEl("input", {
			type: "search",
			placeholder: "Search by title, character or publisher…",
		});
		new ButtonComponent(form).setButtonText("Search").setCta().buttonEl.type = "submit";
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.startSearch(this.inputEl.value);
		});

		this.filtersEl = pageEl.createDiv({ cls: "comic-browser-filters" });
		this.sourceDescriptionEl = pageEl.createDiv({ cls: "comic-browser-source-description" });
		this.buildFilters();

		this.listEl = pageEl.createDiv({ cls: "comic-browser-list" });
		this.statusEl = this.listEl.createDiv({ cls: "comic-browser-status" });
		this.moreButton = new ButtonComponent(pageEl)
			.setButtonText("Load more")
			.setClass("comic-browser-more")
			.onClick(() => this.loadPage(this.nextPage));
		this.moreButton.buttonEl.hide();
	}

	/** The source picker followed by the source's own pickers, e.g. publisher and sort order. */
	private buildFilters(): void {
		this.filtersEl.empty();
		const sourcePicker = new DropdownComponent(this.filtersEl);
		for (const source of this.plugin.sources) sourcePicker.addOption(source.id, source.name);
		sourcePicker.selectEl.setAttribute("aria-label", "Source");
		sourcePicker.setValue(this.source.id).onChange(async (sourceId) => {
			this.plugin.settings.sourceId = sourceId;
			await this.plugin.saveSettings();
			this.source = this.plugin.source;
			this.filesCache.clear();
			this.buildFilters();
			this.startSearch(this.inputEl.value);
		});

		const values = this.filterValues();
		for (const filter of this.source.filters) {
			const picker = new DropdownComponent(this.filtersEl);
			for (const option of filter.options) picker.addOption(option.value, option.label);
			picker.selectEl.setAttribute("aria-label", filter.name);
			picker.setValue(filterValue(this.source.filters, values, filter.id)).onChange(async (value) => {
				this.plugin.settings.filters[this.source.id] = { ...this.filterValues(), [filter.id]: value };
				await this.plugin.saveSettings();
				this.startSearch(this.inputEl.value);
			});
		}
		this.sourceDescriptionEl.setText(this.source.description);
	}

	private filterValues(): FilterValues {
		return this.plugin.settings.filters[this.source.id] ?? {};
	}

	private startSearch(query: string): void {
		this.searched = true;
		this.query = query;
		this.cardRefreshers = [];
		this.listEl.empty();
		this.statusEl = this.listEl.createDiv({ cls: "comic-browser-status" });
		void this.loadPage(1);
	}

	private async loadPage(page: number): Promise<void> {
		const token = ++this.searchToken;
		this.moreButton.buttonEl.hide();
		this.statusEl.setText(page === 1 ? "Searching…" : "Loading more…");
		this.statusEl.show();
		const source = this.source;
		const values = this.filterValues();
		const chosen = source.filters.map((filter) => {
			const value = filterValue(source.filters, values, filter.id);
			return filter.options.find((option) => option.value === value)?.label;
		});
		log.info(`Searching ${source.name} for "${this.query.trim()}", page ${page} (${chosen.join(", ")})`);
		try {
			const { results, hasMore } = await source.search(this.query, page, values);
			if (token !== this.searchToken) return;
			log.info(`Found ${results.length} comics${hasMore ? ", more available" : ""}`);
			this.nextPage = page + 1;
			for (const comic of results) this.renderCard(comic);
			if (page === 1 && results.length === 0) {
				this.statusEl.setText("No comics found. Try other words.");
			} else {
				this.statusEl.hide();
			}
			// Keep the status line below the newest cards.
			this.listEl.appendChild(this.statusEl);
			this.moreButton.setButtonText("Load more").buttonEl.toggle(hasMore);
		} catch (error) {
			if (token !== this.searchToken) return;
			log.error(`Searching ${source.name} failed`, error);
			this.statusEl.setText(`Search failed: ${errorMessage(error)}. Run "Show log" for details.`);
			this.nextPage = page;
			this.moreButton.setButtonText("Try again").buttonEl.show();
		}
	}

	private renderCard(comic: ComicSummary): void {
		const { info, actions } = createCard(this.listEl, comic.name, comic.coverUrl);
		info.createEl("a", { text: comic.name, href: comic.pageUrl, cls: "comic-card-name" });
		if (comic.author) info.createDiv({ text: comic.author, cls: "comic-card-author" });
		if (comic.publisher) info.createDiv({ text: comic.publisher, cls: "comic-card-publisher" });
		if (comic.license) info.createDiv({ text: comic.license, cls: "comic-card-license" });
		if (comic.description && comic.description !== comic.name) {
			info.createDiv({ text: comic.description, cls: "comic-card-description" });
		}

		const button = new ButtonComponent(actions);
		let loading = false;
		const refreshLabel = () => {
			if (loading) return;
			const status = this.plugin.downloads.statusOf(comic);
			button.setButtonText(status ?? (this.plugin.downloadedFiles(comic).length > 0 ? "Read" : "Download"));
		};
		this.cardRefreshers.push(refreshLabel);
		refreshLabel();
		button.onClick(async () => {
			loading = true;
			button.setDisabled(true);
			try {
				await this.downloadOrOpen(comic, (text) => button.setButtonText(text));
			} finally {
				loading = false;
				button.setDisabled(false);
				refreshLabel();
			}
		});
	}

	private async downloadOrOpen(comic: ComicSummary, setLabel: (text: string) => void): Promise<void> {
		const cacheKey = `${comic.sourceId}:${comic.id}`;
		let files = this.filesCache.get(cacheKey);
		if (!files) {
			setLabel("Loading…");
			log.info(`Listing the files of "${comic.name}" (${cacheKey}, ${comic.pageUrl})`);
			try {
				files = await this.source.listFiles(comic);
			} catch (error) {
				log.error(`Could not list the files of "${comic.name}"`, error);
				showErrorNotice(this.plugin, `Could not load "${comic.name}": ${errorMessage(error)}.`);
				return;
			}
			this.filesCache.set(cacheKey, files);
			log.info(
				files.length === 0
					? "No downloadable files found"
					: `Found ${files.length} files:\n${files.map((f) => `${f.label} (${f.extension}): ${f.url}`).join("\n")}`,
			);
		}
		if (files.length === 0) {
			showErrorNotice(this.plugin, `"${comic.name}" has no comic file this plugin can download.`);
			return;
		}

		// One file: name it after the comic. Several: name each after its issue.
		const nameFor = (file: ComicFile) => (files!.length === 1 ? comic.name : file.label);
		const file = files.length === 1 ? files[0] : await this.pickFile(files, (f) => this.existingFile(comic, nameFor(f), f) !== null);
		if (!file) {
			log.info("No issue picked");
			return;
		}

		const existing = this.existingFile(comic, nameFor(file), file);
		if (existing) {
			log.info(`Opening ${existing.path}, which was downloaded before`);
			await this.plugin.recordDownload(comic, existing.path);
			this.close();
			await this.plugin.openInReader(existing);
			return;
		}

		this.plugin.downloads.add(comic, nameFor(file), file);
	}

	private existingFile(comic: ComicSummary, name: string, file: ComicFile): TFile | null {
		const requestedPath = comicPath(this.plugin.settings.comicsFolder, name, file);
		const requested = this.app.vault.getAbstractFileByPath(requestedPath);
		if (requested instanceof TFile) return requested;

		// An opaque GetComics link may have been saved with its detected rather
		// than hinted extension. Only reuse an alternate recorded for this comic.
		const downloadedPaths = new Set(this.plugin.downloadedFiles(comic).map((downloaded) => downloaded.path));
		for (const extension of ["cbz", "pdf", "cbr"] as const) {
			if (extension === file.extension) continue;
			const path = comicPath(this.plugin.settings.comicsFolder, name, { ...file, extension });
			if (!downloadedPaths.has(path)) continue;
			const found = this.app.vault.getAbstractFileByPath(path);
			if (found instanceof TFile) return found;
		}
		return null;
	}

	private pickFile(files: ComicFile[], isDownloaded: (file: ComicFile) => boolean): Promise<ComicFile | null> {
		return new Promise((resolve) => new FilePickerModal(this.app, files, isDownloaded, resolve).open());
	}
}
