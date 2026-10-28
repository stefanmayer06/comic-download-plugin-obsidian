import { ButtonComponent, DropdownComponent, Modal, Notice, TFile } from "obsidian";
import { comicPath, downloadComic } from "../downloader";
import type ComicDownloaderPlugin from "../main";
import type { ComicFile, ComicSource, ComicSummary } from "../sources/types";
import { FilePickerModal } from "./FilePickerModal";

/**
 * The download menu: a search box over a scrolling list of comic cards.
 * Each card shows name, author, publisher and description, a download
 * button and the cover.
 */
export class ComicBrowserModal extends Modal {
	private source: ComicSource;
	private query = "";
	/** The page "Load more" (or "Try again") fetches next. */
	private nextPage = 1;
	/** Guards against an older search finishing after a newer one. */
	private searchToken = 0;
	private filesCache = new Map<string, ComicFile[]>();

	private inputEl!: HTMLInputElement;
	private sourceDescriptionEl!: HTMLElement;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private moreButton!: ButtonComponent;

	constructor(private plugin: ComicDownloaderPlugin) {
		super(plugin.app);
		this.source = plugin.source;
	}

	onOpen(): void {
		this.modalEl.addClass("comic-browser-modal");
		this.titleEl.setText("Download comics");
		const { contentEl } = this;

		const form = contentEl.createEl("form", { cls: "comic-browser-search" });
		this.inputEl = form.createEl("input", {
			type: "search",
			placeholder: "Search by title, character or publisher…",
		});
		new ButtonComponent(form).setButtonText("Search").setCta().buttonEl.type = "submit";
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.startSearch(this.inputEl.value);
		});

		const sourceEl = contentEl.createDiv({ cls: "comic-browser-source" });
		sourceEl.createSpan({ text: "Source:" });
		const sourcePicker = new DropdownComponent(sourceEl);
		for (const source of this.plugin.sources) sourcePicker.addOption(source.id, source.name);
		sourcePicker.selectEl.setAttribute("aria-label", "Comic source");
		sourcePicker.setValue(this.source.id).onChange(async (sourceId) => {
			this.plugin.settings.sourceId = sourceId;
			await this.plugin.saveSettings();
			this.source = this.plugin.source;
			this.sourceDescriptionEl.setText(this.source.description);
			this.filesCache.clear();
			this.startSearch(this.inputEl.value);
		});
		this.sourceDescriptionEl = sourceEl.createSpan({
			cls: "comic-browser-source-description",
			text: this.source.description,
		});

		this.listEl = contentEl.createDiv({ cls: "comic-browser-list" });
		this.statusEl = this.listEl.createDiv({ cls: "comic-browser-status" });
		this.moreButton = new ButtonComponent(contentEl)
			.setButtonText("Load more")
			.setClass("comic-browser-more")
			.onClick(() => this.loadPage(this.nextPage));
		this.moreButton.buttonEl.hide();

		this.inputEl.focus();
		this.startSearch("");
	}

	onClose(): void {
		this.searchToken++;
		this.contentEl.empty();
	}

	private startSearch(query: string): void {
		this.query = query;
		this.listEl.empty();
		this.statusEl = this.listEl.createDiv({ cls: "comic-browser-status" });
		void this.loadPage(1);
	}

	private async loadPage(page: number): Promise<void> {
		const token = ++this.searchToken;
		this.moreButton.buttonEl.hide();
		this.statusEl.setText(page === 1 ? "Searching…" : "Loading more…");
		this.statusEl.show();
		try {
			const { results, hasMore } = await this.source.search(this.query, page);
			if (token !== this.searchToken) return;
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
			console.error("Comic Downloader: search failed", error);
			this.statusEl.setText("Search failed. Check your connection and try again.");
			this.nextPage = page;
			this.moreButton.setButtonText("Try again").buttonEl.show();
		}
	}

	private renderCard(comic: ComicSummary): void {
		const card = this.listEl.createDiv({ cls: "comic-card" });

		const info = card.createDiv({ cls: "comic-card-info" });
		info.createEl("a", { text: comic.name, href: comic.pageUrl, cls: "comic-card-name" });
		if (comic.author) info.createDiv({ text: comic.author, cls: "comic-card-author" });
		if (comic.publisher) info.createDiv({ text: comic.publisher, cls: "comic-card-publisher" });
		if (comic.license) info.createDiv({ text: comic.license, cls: "comic-card-license" });
		if (comic.description && comic.description !== comic.name) {
			info.createDiv({ text: comic.description, cls: "comic-card-description" });
		}

		const actions = card.createDiv({ cls: "comic-card-actions" });
		const button = new ButtonComponent(actions);
		const refreshLabel = () => {
			button.setButtonText(this.plugin.downloadedFiles(comic).length > 0 ? "Read" : "Download");
		};
		refreshLabel();
		button.onClick(async () => {
			button.setDisabled(true);
			try {
				await this.downloadOrOpen(comic, (text) => button.setButtonText(text));
			} finally {
				button.setDisabled(false);
				refreshLabel();
			}
		});

		const cover = card.createDiv({ cls: "comic-card-cover" });
		if (comic.coverUrl) {
			const img = cover.createEl("img", { attr: { src: comic.coverUrl, alt: `Cover of ${comic.name}`, loading: "lazy" } });
			img.addEventListener("error", () => {
				img.remove();
				cover.setText("No cover");
			});
		} else {
			cover.setText("No cover");
		}
	}

	private async downloadOrOpen(comic: ComicSummary, setLabel: (text: string) => void): Promise<void> {
		const cacheKey = `${comic.sourceId}:${comic.id}`;
		let files = this.filesCache.get(cacheKey);
		if (!files) {
			setLabel("Loading…");
			try {
				files = await this.source.listFiles(comic);
			} catch (error) {
				console.error("Comic Downloader: could not list files", error);
				new Notice(`Could not load "${comic.name}". Try again later.`);
				return;
			}
			this.filesCache.set(cacheKey, files);
		}
		if (files.length === 0) {
			new Notice(`"${comic.name}" has no comic file the reader can open.`);
			return;
		}

		// One file: name it after the comic. Several: name each after its issue.
		const nameFor = (file: ComicFile) => (files!.length === 1 ? comic.name : file.label);
		const file = files.length === 1 ? files[0] : await this.pickFile(files, (f) => this.existingFile(comic, nameFor(f), f) !== null);
		if (!file) return;

		const existing = this.existingFile(comic, nameFor(file), file);
		if (existing) {
			await this.plugin.recordDownload(comic, existing.path);
			this.close();
			await this.plugin.openInReader(existing);
			return;
		}

		setLabel("Downloading…");
		const notice = new Notice(`Downloading "${nameFor(file)}"…`, 0);
		try {
			const saved = await downloadComic(this.app, this.plugin.settings.comicsFolder, nameFor(file), file);
			await this.plugin.recordDownload(comic, saved.path);
			notice.hide();
			this.showDownloadedNotice(saved);
		} catch (error) {
			notice.hide();
			console.error("Comic Downloader: download failed", error);
			new Notice(`Download of "${nameFor(file)}" failed. Try again later.`);
		}
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

	private showDownloadedNotice(file: TFile): void {
		const fragment = createFragment((frag) => {
			frag.appendText(`Saved to ${file.path}. `);
			if (file.extension === "cbr") {
				frag.appendText("CBR files can't be opened by the reader yet.");
				return;
			}
			const link = frag.createEl("a", { text: "Read now", href: "#" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				this.close();
				void this.plugin.openInReader(file);
			});
		});
		new Notice(fragment, 8000);
	}
}
