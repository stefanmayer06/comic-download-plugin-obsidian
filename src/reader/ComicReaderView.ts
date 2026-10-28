import { ButtonComponent, debounce, FileView, Scope, TFile, WorkspaceLeaf } from "obsidian";
import type ComicDownloaderPlugin from "../main";
import { openPages, PageSource } from "./pages";

export const VIEW_TYPE_COMIC_READER = "comic-reader";
export const READER_EXTENSIONS = ["cbz", "pdf"];

/** Horizontal drag, in pixels, that counts as a swipe instead of a tap. */
const SWIPE_DISTANCE = 50;

/**
 * Shows a comic one page at a time. Pages turn by tapping the left or right
 * side, swiping, or with the arrow keys; nothing scrolls between pages,
 * which keeps e-ink screens free of ghosting.
 */
export class ComicReaderView extends FileView {
	private pages: PageSource | null = null;
	private index = 0;
	/** Ignores a page that finishes loading after the reader has moved on. */
	private renderToken = 0;

	private stageEl!: HTMLElement;
	private imageEl!: HTMLImageElement;
	private messageEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private counterEl!: HTMLElement;
	private sliderEl!: HTMLInputElement;
	private fitButton!: ButtonComponent;

	private saveProgress = debounce(() => void this.plugin.saveSettings(), 1000, true);

	constructor(leaf: WorkspaceLeaf, private plugin: ComicDownloaderPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		const turn = (forward: boolean) => () => {
			this.turn(forward);
			return false;
		};
		this.scope.register([], "ArrowRight", () => {
			this.turn(!this.isRightToLeft());
			return false;
		});
		this.scope.register([], "ArrowLeft", () => {
			this.turn(this.isRightToLeft());
			return false;
		});
		this.scope.register([], "PageDown", turn(true));
		this.scope.register([], " ", turn(true));
		this.scope.register([], "PageUp", turn(false));
		this.scope.register(["Shift"], " ", turn(false));
		this.scope.register([], "Home", () => {
			void this.showPage(0);
			return false;
		});
		this.scope.register([], "End", () => {
			if (this.pages) void this.showPage(this.pages.pageCount - 1);
			return false;
		});
	}

	getViewType(): string {
		return VIEW_TYPE_COMIC_READER;
	}

	getIcon(): string {
		return "book-open";
	}

	canAcceptExtension(extension: string): boolean {
		return READER_EXTENSIONS.includes(extension);
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("comic-reader");

		this.stageEl = this.contentEl.createDiv({ cls: "comic-reader-stage" });
		this.imageEl = this.stageEl.createEl("img", { cls: "comic-reader-page" });
		this.imageEl.draggable = false;
		this.messageEl = this.stageEl.createDiv({ cls: "comic-reader-message" });
		this.registerPointerNavigation();

		this.toolbarEl = this.contentEl.createDiv({ cls: "comic-reader-toolbar" });
		const prev = new ButtonComponent(this.toolbarEl).setIcon("chevron-left").setTooltip("Previous page");
		prev.onClick(() => this.turn(this.isRightToLeft()));
		this.counterEl = this.toolbarEl.createDiv({ cls: "comic-reader-counter" });
		this.sliderEl = this.toolbarEl.createEl("input", { type: "range", cls: "comic-reader-slider" });
		this.sliderEl.min = "1";
		this.sliderEl.addEventListener("change", () => void this.showPage(Number(this.sliderEl.value) - 1));
		const next = new ButtonComponent(this.toolbarEl).setIcon("chevron-right").setTooltip("Next page");
		next.onClick(() => this.turn(!this.isRightToLeft()));
		this.fitButton = new ButtonComponent(this.toolbarEl).onClick(async () => {
			const settings = this.plugin.settings;
			settings.fitMode = settings.fitMode === "page" ? "width" : "page";
			await this.plugin.saveSettings();
			this.plugin.refreshReaders();
		});
		this.applySettings();
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.closePages();
		const token = ++this.renderToken;
		this.showMessage("Opening comic…");
		try {
			const data = await this.app.vault.readBinary(file);
			const pages = await openPages(file.extension, data);
			if (token !== this.renderToken) {
				pages.destroy();
				return;
			}
			this.pages = pages;
			this.sliderEl.max = String(pages.pageCount);
			const saved = this.plugin.settings.progress[file.path] ?? 0;
			await this.showPage(Math.min(Math.max(saved, 0), pages.pageCount - 1));
		} catch (error) {
			if (token !== this.renderToken) return;
			console.error("Comic Downloader: could not open comic", error);
			this.showMessage(`Could not open this comic. ${error instanceof Error ? error.message : ""}`);
		}
	}

	async onUnloadFile(): Promise<void> {
		this.closePages();
	}

	async onClose(): Promise<void> {
		this.closePages();
	}

	private closePages(): void {
		this.renderToken++;
		this.pages?.destroy();
		this.pages = null;
		this.imageEl?.removeAttribute("src");
	}

	/** Called when settings change so open readers pick up the new layout. */
	applySettings(): void {
		const { fitMode, readingDirection } = this.plugin.settings;
		this.contentEl.toggleClass("is-fit-width", fitMode === "width");
		this.contentEl.toggleClass("is-rtl", readingDirection === "rtl");
		this.sliderEl.dir = readingDirection;
		this.fitButton
			.setIcon(fitMode === "page" ? "move-horizontal" : "maximize")
			.setTooltip(fitMode === "page" ? "Fit width" : "Show whole page");
	}

	private isRightToLeft(): boolean {
		return this.plugin.settings.readingDirection === "rtl";
	}

	turn(forward: boolean): void {
		if (!this.pages) return;
		const target = this.index + (forward ? 1 : -1);
		if (target >= 0 && target < this.pages.pageCount) void this.showPage(target);
	}

	private async showPage(index: number): Promise<void> {
		const pages = this.pages;
		if (!pages || !this.file) return;
		const token = ++this.renderToken;
		this.index = index;
		this.counterEl.setText(`${index + 1} / ${pages.pageCount}`);
		this.sliderEl.value = String(index + 1);
		this.plugin.settings.progress[this.file.path] = index;
		this.saveProgress();

		try {
			const url = await pages.getPage(index);
			if (token !== this.renderToken) return;
			this.messageEl.hide();
			this.imageEl.src = url;
			this.imageEl.alt = `Page ${index + 1}`;
			this.imageEl.show();
			this.stageEl.scrollTop = 0;
		} catch (error) {
			if (token !== this.renderToken) return;
			console.error("Comic Downloader: could not show page", error);
			this.showMessage(`Page ${index + 1} could not be shown.`);
			return;
		}

		// Decode the neighbours in the background so the next turn is instant.
		for (const neighbour of [index + 1, index - 1]) {
			if (neighbour >= 0 && neighbour < pages.pageCount) pages.getPage(neighbour).catch(() => undefined);
		}
	}

	private showMessage(text: string): void {
		this.imageEl.hide();
		this.messageEl.setText(text);
		this.messageEl.show();
	}

	/**
	 * Tap the outer thirds of the page to turn it, the middle to show or hide
	 * the toolbar, or swipe sideways.
	 */
	private registerPointerNavigation(): void {
		let startX: number | null = null;
		let startY = 0;
		this.registerDomEvent(this.stageEl, "pointerdown", (event) => {
			if (!event.isPrimary || event.button !== 0) return;
			startX = event.clientX;
			startY = event.clientY;
		});
		this.registerDomEvent(this.stageEl, "pointercancel", () => (startX = null));
		this.registerDomEvent(this.stageEl, "pointerup", (event) => {
			if (startX === null || !event.isPrimary) return;
			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			startX = null;
			// Vertical drags scroll a page shown at full width.
			if (Math.abs(dy) > SWIPE_DISTANCE && Math.abs(dy) > Math.abs(dx)) return;

			if (Math.abs(dx) > SWIPE_DISTANCE) {
				// Swiping left pulls in the page on the right.
				this.turn(dx < 0 !== this.isRightToLeft());
				return;
			}
			const rect = this.stageEl.getBoundingClientRect();
			const position = (event.clientX - rect.left) / rect.width;
			if (position < 1 / 3) this.turn(this.isRightToLeft());
			else if (position > 2 / 3) this.turn(!this.isRightToLeft());
			else this.contentEl.toggleClass("is-toolbar-hidden", !this.contentEl.hasClass("is-toolbar-hidden"));
		});
	}
}
