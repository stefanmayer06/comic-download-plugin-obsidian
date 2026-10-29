import { ButtonComponent, debounce, DropdownComponent, EventRef, moment, normalizePath, Notice, TFile } from "obsidian";
import { log } from "../log";
import type ComicDownloaderPlugin from "../main";
import { READER_EXTENSIONS } from "../reader/ComicReaderView";
import type { InstalledSort } from "../settings";
import { errorMessage, formatBytes, naturalCompare } from "../util";
import { createCard } from "./card";

const COMIC_EXTENSIONS = ["cbz", "pdf", "cbr"];

/** How long "Confirm delete" stays up after "Delete" is pressed. */
const CONFIRM_DELETE_MS = 4000;

/**
 * The download menu's Installed page: downloads in progress, then the
 * comics in the comics folder (and any downloaded file moved elsewhere),
 * each with Read and Delete buttons.
 */
export class InstalledView {
	private query = "";
	private publisher = "";
	private publisherPicker: DropdownComponent;
	private downloadingEl: HTMLElement;
	private listEl: HTMLElement;
	private vaultEvents: EventRef[] = [];
	private stopWatchingDownloads: () => void;
	private renderSoon = debounce(() => this.render(), 300, true);

	constructor(
		private plugin: ComicDownloaderPlugin,
		containerEl: HTMLElement,
		private closeMenu: () => void,
	) {
		const toolbar = containerEl.createDiv({ cls: "comic-browser-search" });
		const input = toolbar.createEl("input", { type: "search", placeholder: "Filter downloaded comics…" });
		input.addEventListener("input", () => {
			this.query = input.value.trim().toLowerCase();
			this.render();
		});

		const filters = containerEl.createDiv({ cls: "comic-browser-filters" });
		this.publisherPicker = new DropdownComponent(filters).onChange((publisher) => {
			this.publisher = publisher;
			this.render();
		});
		this.publisherPicker.selectEl.setAttribute("aria-label", "Publisher");
		new DropdownComponent(filters)
			.addOptions({ recent: "Recently downloaded", "title-az": "Title A–Z", "title-za": "Title Z–A" })
			.setValue(plugin.settings.installedSort)
			.onChange(async (sort) => {
				plugin.settings.installedSort = sort as InstalledSort;
				await plugin.saveSettings();
				this.render();
			})
			.selectEl.setAttribute("aria-label", "Sort");

		const scroller = containerEl.createDiv({ cls: "comic-browser-list" });
		this.downloadingEl = scroller.createDiv({ cls: "comic-installed-downloading" });
		this.listEl = scroller.createDiv({ cls: "comic-installed-list" });

		const { vault } = plugin.app;
		this.vaultEvents = [vault.on("create", this.renderSoon), vault.on("delete", this.renderSoon), vault.on("rename", this.renderSoon)];
		this.stopWatchingDownloads = plugin.downloads.onChange(() => this.renderDownloading());
	}

	destroy(): void {
		for (const ref of this.vaultEvents) this.plugin.app.vault.offref(ref);
		this.stopWatchingDownloads();
		this.plugin.covers.cancelWaiting();
	}

	render(): void {
		this.renderDownloading();
		this.listEl.empty();

		const files = this.comicFiles();
		this.updatePublisherPicker(files);
		const shown = files
			.filter((file) => !this.query || file.basename.toLowerCase().includes(this.query))
			.filter((file) => !this.publisher || this.plugin.libraryEntry(file.path)?.publisher === this.publisher);
		const sort = this.plugin.settings.installedSort;
		shown.sort((a, b) => {
			if (sort === "recent") return b.stat.ctime - a.stat.ctime;
			const order = naturalCompare(a.basename, b.basename);
			return sort === "title-za" ? -order : order;
		});

		if (files.length === 0) {
			this.listEl.createDiv({ cls: "comic-browser-status", text: "No comics downloaded yet. Find some under Browse." });
			return;
		}
		if (shown.length === 0) {
			this.listEl.createDiv({ cls: "comic-browser-status", text: "No downloaded comics match." });
			return;
		}
		for (const file of shown) this.renderCard(file);
	}

	/** Comic files in the comics folder, plus downloaded ones moved out of it. */
	private comicFiles(): TFile[] {
		const { vault } = this.plugin.app;
		const folder = normalizePath(this.plugin.settings.comicsFolder);
		const files = new Set(vault.getFiles().filter((file) => file.path.startsWith(`${folder}/`) && COMIC_EXTENSIONS.includes(file.extension)));
		for (const path of Object.values(this.plugin.settings.downloads).flat()) {
			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) files.add(file);
		}
		return [...files];
	}

	/** Offers the publishers of the comics shown; hidden while none is known. */
	private updatePublisherPicker(files: TFile[]): void {
		const publishers = [...new Set(files.map((file) => this.plugin.libraryEntry(file.path)?.publisher).filter((publisher): publisher is string => !!publisher))];
		publishers.sort(naturalCompare);
		if (!publishers.includes(this.publisher)) this.publisher = "";
		const select = this.publisherPicker.selectEl;
		select.empty();
		this.publisherPicker.addOption("", "All publishers");
		for (const publisher of publishers) this.publisherPicker.addOption(publisher, publisher);
		this.publisherPicker.setValue(this.publisher);
		select.toggle(publishers.length > 0);
	}

	private renderDownloading(): void {
		this.downloadingEl.empty();
		const downloads = this.plugin.downloads.list();
		this.downloadingEl.toggle(downloads.length > 0);
		for (const download of downloads) {
			const row = this.downloadingEl.createDiv({ cls: "comic-installed-download" });
			row.createDiv({ cls: "comic-installed-download-name", text: download.name });
			row.createDiv({ cls: "comic-installed-download-status", text: download.status });
			new ButtonComponent(row).setButtonText("Cancel").onClick(download.cancel);
		}
	}

	private renderCard(file: TFile): void {
		const entry = this.plugin.libraryEntry(file.path);
		// The comic's own first page: it shows offline and needs no saved details. The source's cover is a fallback.
		const cover = async () => (await this.plugin.covers.get(file)) ?? entry?.coverUrl ?? null;
		const { info, actions } = createCard(this.listEl, file.basename, cover);

		info.createDiv({ text: file.basename, cls: "comic-card-name" });
		if (entry?.publisher) info.createDiv({ text: entry.publisher, cls: "comic-card-publisher" });
		info.createDiv({ text: `${file.extension.toUpperCase()} · ${formatBytes(file.stat.size)} · downloaded ${moment(file.stat.ctime).fromNow()}`, cls: "comic-card-license" });
		const page = this.plugin.settings.progress[file.path];
		if (page !== undefined && page > 0) info.createDiv({ text: `Read up to page ${page + 1}`, cls: "comic-card-author" });

		const canRead = READER_EXTENSIONS.includes(file.extension);
		const read = new ButtonComponent(actions)
			.setButtonText("Read")
			.setCta()
			.setDisabled(!canRead)
			.onClick(() => {
				this.closeMenu();
				void this.plugin.openInReader(file);
			});
		if (!canRead) read.setTooltip(`The reader can't open .${file.extension} files yet`);

		let confirmUntil = 0;
		const remove = new ButtonComponent(actions).setButtonText("Delete");
		remove.onClick(async () => {
			if (Date.now() > confirmUntil) {
				confirmUntil = Date.now() + CONFIRM_DELETE_MS;
				remove.setButtonText("Confirm delete").setWarning();
				window.setTimeout(() => {
					if (Date.now() < confirmUntil) return;
					remove.setButtonText("Delete").buttonEl.removeClass("mod-warning");
				}, CONFIRM_DELETE_MS + 50);
				return;
			}
			try {
				// The system trash, or Obsidian's .trash folder where there is none.
				await this.plugin.app.vault.trash(file, true);
				log.info(`Moved ${file.path} to the trash`);
				new Notice(`Moved ${file.name} to the trash.`);
			} catch (error) {
				log.error(`Could not delete ${file.path}`, error);
				new Notice(`Could not delete ${file.name}: ${errorMessage(error)}`);
			}
		});
	}
}
