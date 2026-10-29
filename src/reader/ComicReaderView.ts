import { ButtonComponent, debounce, FileView, Scope, Setting, TFile, ToggleComponent, WorkspaceLeaf } from "obsidian";
import { log } from "../log";
import type ComicDownloaderPlugin from "../main";
import { DEFAULT_PAGE_LOOK, PageLookSettings } from "../settings";
import { ORIGINAL_LOOK, PageBox, PageLook, renderPage } from "./display";
import { openPages, PageSource } from "./pages";

export const VIEW_TYPE_COMIC_READER = "comic-reader";
export const READER_EXTENSIONS = ["cbz", "cbr", "pdf"];

/** Horizontal drag, in pixels, that counts as a swipe instead of a tap. */
const SWIPE_DISTANCE = 50;

/** How many pages around the current one stay rendered for the screen. */
const RENDERED_AROUND = 1;

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

	/** Pages drawn for the current box and look, by index. */
	private rendered = new Map<number, Promise<ImageBitmap>>();
	/** The box and look `rendered` was drawn for. */
	private renderedFor = "";

	private stageEl!: HTMLElement;
	private canvasEl!: HTMLCanvasElement;
	private messageEl!: HTMLElement;
	private adjustEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private counterEl!: HTMLElement;
	private sliderEl!: HTMLInputElement;
	private fitButton!: ButtonComponent;
	private enhanceButton!: ButtonComponent;

	private saveProgress = debounce(() => void this.plugin.saveSettings(), 1000, true);
	/** Redraws the page once the reader has settled on a new size. */
	private redrawSoon = debounce(() => this.redrawIfChanged(), 200, true);

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
		this.canvasEl = this.stageEl.createEl("canvas", { cls: "comic-reader-page" });
		this.messageEl = this.stageEl.createDiv({ cls: "comic-reader-message" });
		this.registerPointerNavigation();
		const resizeObserver = new ResizeObserver(() => this.redrawSoon());
		resizeObserver.observe(this.stageEl);
		this.register(() => resizeObserver.disconnect());

		this.toolbarEl = this.contentEl.createDiv({ cls: "comic-reader-toolbar" });
		// Floats above the toolbar, so opening it doesn't shrink the page being adjusted.
		this.adjustEl = this.toolbarEl.createDiv({ cls: "comic-reader-adjust" });
		this.adjustEl.hide();
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
		this.enhanceButton = new ButtonComponent(this.toolbarEl).setIcon("palette").onClick(async () => {
			this.plugin.settings.enhancePages = !this.plugin.settings.enhancePages;
			await this.plugin.saveSettings();
			this.plugin.refreshReaders();
		});
		new ButtonComponent(this.toolbarEl)
			.setIcon("sliders-horizontal")
			.setTooltip("Adjust colours and sharpness")
			.onClick(() => this.toggleAdjustments());
		this.applySettings();
	}

	/** Whether the reader's toolbar is hidden; in full screen, Obsidian's bars hide with it. */
	get toolbarHidden(): boolean {
		return this.contentEl.hasClass("is-toolbar-hidden");
	}

	/** Sliders for the e-ink look, shown above the toolbar while the page stays in view. */
	private toggleAdjustments(): void {
		if (this.adjustEl.isShown()) {
			this.adjustEl.hide();
			return;
		}
		this.adjustEl.empty();
		const settings = this.plugin.settings;
		const save = async () => {
			await this.plugin.saveSettings();
			this.plugin.refreshReaders();
		};
		// The e-ink screen's refresh mode matters more than any of these sliders, and only Boox can change it.
		this.adjustEl.createDiv({
			cls: "comic-reader-adjust-tip",
			text:
				"On a Boox: if pages show a dotted or striped pattern, Obsidian is in a fast refresh mode, which dithers images. " +
				"Set Obsidian's refresh mode to HD in the Boox Control Center.",
		});
		let enhanceToggle: ToggleComponent | null = null;
		new Setting(this.adjustEl)
			.setName("Enhance for e-ink")
			.setDesc("Off shows pages as the file has them.")
			.addToggle((toggle) => {
				enhanceToggle = toggle;
				toggle.setValue(settings.enhancePages).onChange(async (value) => {
					settings.enhancePages = value;
					await save();
				});
			});
		const slider = (name: string, key: keyof PageLookSettings, min: number, max: number, step: number) =>
			new Setting(this.adjustEl).setName(name).addSlider((input) =>
				input
					.setLimits(min, max, step)
					.setValue(settings.pageLook[key])
					.setDynamicTooltip()
					// Redraw once a slider is let go: redrawing while dragging would flash an e-ink screen.
					.setInstant(false)
					.onChange(async (value) => {
						settings.pageLook = { ...settings.pageLook, [key]: value };
						// Adjusting the look means wanting to see it.
						settings.enhancePages = true;
						enhanceToggle?.setValue(true);
						await save();
					}),
			);
		slider("Saturation", "saturation", 100, 250, 5);
		slider("Contrast", "contrast", 80, 160, 5);
		slider("Darken mid-tones", "darken", 0, 100, 5);
		slider("Sharpness", "sharpness", 0, 100, 5);
		new Setting(this.adjustEl).addButton((button) =>
			button.setButtonText("Reset").onClick(async () => {
				settings.pageLook = { ...DEFAULT_PAGE_LOOK };
				await save();
				this.adjustEl.hide();
				this.toggleAdjustments();
			}),
		);
		this.adjustEl.show();
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
			log.error(`Could not open ${file.path} in the reader`, error);
			this.showMessage(`Could not open this comic. ${error instanceof Error ? error.message : ""}`);
		}
	}

	async onUnloadFile(): Promise<void> {
		this.closePages();
	}

	async onClose(): Promise<void> {
		this.closePages();
		this.plugin.updateFullScreen();
	}

	private closePages(): void {
		this.renderToken++;
		this.pages?.destroy();
		this.pages = null;
		this.clearRendered();
		if (this.canvasEl) this.canvasEl.width = this.canvasEl.height = 0;
	}

	private clearRendered(): void {
		for (const bitmap of this.rendered.values()) bitmap.then((done) => done.close(), () => undefined);
		this.rendered.clear();
	}

	/** Called when settings change so open readers pick up the new layout and look. */
	applySettings(): void {
		const { fitMode, readingDirection, enhancePages } = this.plugin.settings;
		this.contentEl.toggleClass("is-fit-width", fitMode === "width");
		this.contentEl.toggleClass("is-rtl", readingDirection === "rtl");
		this.sliderEl.dir = readingDirection;
		this.fitButton
			.setIcon(fitMode === "page" ? "move-horizontal" : "maximize")
			.setTooltip(fitMode === "page" ? "Fit width" : "Show whole page");
		this.enhanceButton.buttonEl.toggleClass("is-active", enhancePages);
		this.enhanceButton.setTooltip(enhancePages ? "Show original colours" : "Enhance colours and sharpness for e-ink");
		this.redrawIfChanged();
	}

	/** The device pixels the page is drawn into. */
	private pageBox(): PageBox {
		const ratio = this.stageEl.win.devicePixelRatio || 1;
		return {
			width: Math.round(this.stageEl.clientWidth * ratio),
			height: Math.round(this.stageEl.clientHeight * ratio),
			fitWidth: this.plugin.settings.fitMode === "width",
		};
	}

	private pageLook(): PageLook {
		const { enhancePages, pageLook } = this.plugin.settings;
		if (!enhancePages) return ORIGINAL_LOOK;
		return {
			saturation: pageLook.saturation / 100,
			contrast: pageLook.contrast / 100,
			gamma: 1 + pageLook.darken / 100,
			sharpness: (pageLook.sharpness / 100) * 1.5,
		};
	}

	/** Redraws the current page if the reader's size, fit or look has changed since it was drawn. */
	private redrawIfChanged(): void {
		if (!this.pages || this.renderedFor === JSON.stringify([this.pageBox(), this.pageLook()])) return;
		void this.showPage(this.index);
	}

	/** The page drawn for the screen, from the cache when it is there. */
	private renderedPage(index: number): Promise<ImageBitmap> {
		const pages = this.pages;
		if (!pages) return Promise.reject(new Error("No comic is open"));
		const box = this.pageBox();
		const look = this.pageLook();
		const key = JSON.stringify([box, look]);
		if (key !== this.renderedFor) {
			this.clearRendered();
			this.renderedFor = key;
		}
		let bitmap = this.rendered.get(index);
		if (!bitmap) {
			bitmap = pages.getPage(index).then((image) => renderPage(image, box, look));
			bitmap.catch(() => this.rendered.delete(index));
			this.rendered.set(index, bitmap);
		}
		// Keep the pages around the one on screen, not around a neighbour being rendered ahead.
		for (const [page, other] of this.rendered) {
			if (page === index || Math.abs(page - this.index) <= RENDERED_AROUND) continue;
			this.rendered.delete(page);
			other.then((done) => done.close(), () => undefined);
		}
		return bitmap;
	}

	/** Shows a rendered page at one canvas pixel per device pixel. */
	private draw(bitmap: ImageBitmap): void {
		const ratio = this.stageEl.win.devicePixelRatio || 1;
		this.canvasEl.width = bitmap.width;
		this.canvasEl.height = bitmap.height;
		this.canvasEl.setCssStyles({ width: `${bitmap.width / ratio}px`, height: `${bitmap.height / ratio}px` });
		this.canvasEl.getContext("2d")?.drawImage(bitmap, 0, 0);
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

		// A reader that isn't on screen has no size; it draws when it gets one.
		if (this.stageEl.clientWidth === 0 || this.stageEl.clientHeight === 0) return;
		try {
			const bitmap = await this.renderedPage(index);
			if (token !== this.renderToken) return;
			this.messageEl.hide();
			this.draw(bitmap);
			this.canvasEl.setAttribute("aria-label", `Page ${index + 1}`);
			this.canvasEl.show();
			this.stageEl.scrollTop = 0;
		} catch (error) {
			if (token !== this.renderToken) return;
			log.error(`Could not show page ${index + 1} of ${this.file.path}`, error);
			this.showMessage(`Page ${index + 1} could not be shown.`);
			return;
		}

		// Render the neighbours in the background so the next turn is instant.
		for (const neighbour of [index + 1, index - 1]) {
			if (neighbour >= 0 && neighbour < pages.pageCount) this.renderedPage(neighbour).catch(() => undefined);
		}
	}

	private showMessage(text: string): void {
		this.canvasEl.hide();
		this.messageEl.setText(text);
		this.messageEl.show();
	}

	private toggleToolbar(): void {
		this.contentEl.toggleClass("is-toolbar-hidden", !this.toolbarHidden);
		if (this.toolbarHidden) this.adjustEl.hide();
		this.plugin.updateFullScreen();
	}

	/**
	 * Tap the outer thirds of the page to turn it, the middle to show or hide
	 * the toolbar (and, in full screen, Obsidian's bars), or swipe sideways.
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
			else this.toggleToolbar();
		});
	}
}
