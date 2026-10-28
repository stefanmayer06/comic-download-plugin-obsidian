import { ButtonComponent, DropdownComponent, Modal, Notice, TFile } from "obsidian";
import { comicPath, downloadComic } from "../downloader";
import { log } from "../log";
import type ComicDownloaderPlugin from "../main";
import type { ComicFile, ComicSource, ComicSummary } from "../sources/types";
import { errorMessage } from "../util";
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
		const source = this.source;
		log.info(`Searching ${source.name} for "${this.query.trim()}", page ${page}`);
		try {
			const { results, hasMore } = await source.search(this.query, page);
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
			log.info(`Listing the files of "${comic.name}" (${cacheKey}, ${comic.pageUrl})`);
			try {
				files = await this.source.listFiles(comic);
			} catch (error) {
				log.error(`Could not list the files of "${comic.name}"`, error);
				this.showErrorNotice(`Could not load "${comic.name}": ${errorMessage(error)}.`);
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
			this.showErrorNotice(`"${comic.name}" has no comic file this plugin can download.`);
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

		setLabel("Downloading…");
		const notice = new Notice(`Downloading "${nameFor(file)}"…`, 0);
		try {
			const saved = await downloadComic(this.app, this.plugin.settings.comicsFolder, nameFor(file), file);
			await this.plugin.recordDownload(comic, saved.path);
			notice.hide();
			this.showDownloadedNotice(saved);
		} catch (error) {
			notice.hide();
			log.error(`Download of "${nameFor(file)}" failed`, error);
			this.showErrorNotice(`Download of "${nameFor(file)}" failed: ${errorMessage(error)}.`);
		}
	}

	/** A notice with a link to the log, which has the details. */
	private showErrorNotice(message: string): void {
		const fragment = createFragment((frag) => {
			frag.appendText(`${message} `);
			const link = frag.createEl("a", { text: "Show log", href: "#" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				this.plugin.showLog();
			});
		});
		new Notice(fragment, 15000);
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
