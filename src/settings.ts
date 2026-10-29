import { App, PluginSettingTab, Setting } from "obsidian";
import type { FoundFile } from "./downloader";
import type ComicDownloaderPlugin from "./main";
import type { SearchScope } from "./sources/internetArchive";
import type { ComicFile, ComicSummary, FilterValues } from "./sources/types";

export type FitMode = "page" | "width";
export type ReadingDirection = "ltr" | "rtl";
export type BrowserTab = "browse" | "installed";
export type InstalledSort = "recent" | "title-az" | "title-za";
/** What the Installed page shows about a downloaded comic. */
export type LibraryEntry = Omit<ComicSummary, "description">;

/** A download waiting its turn or under way, kept so it carries on after Obsidian restarts. */
export interface QueuedDownload {
	/** Names the folder its pieces are kept in. */
	id: string;
	comic: ComicSummary;
	/** The file name to save it under, without extension. */
	name: string;
	file: ComicFile;
	/** Set once the first piece is saved. */
	found?: FoundFile;
}

/** The reader's e-ink adjustments, as the percentages its sliders show. */
export interface PageLookSettings {
	saturation: number;
	contrast: number;
	/** 0 leaves mid-tones as they are; 100 darkens them as much as allowed. */
	darken: number;
	sharpness: number;
}

/** Stronger colours, darker mid-tones and some sharpening, for colour e-ink screens. */
export const DEFAULT_PAGE_LOOK: PageLookSettings = { saturation: 140, contrast: 110, darken: 15, sharpness: 40 };

export interface ComicDownloaderSettings {
	comicsFolder: string;
	sourceId: string;
	/** Source id -> publisher, type and sort chosen in the download menu. */
	filters: Record<string, FilterValues>;
	/** The download menu's page last open. */
	browserTab: BrowserTab;
	installedSort: InstalledSort;
	searchScope: SearchScope;
	resultsPerPage: number;
	fitMode: FitMode;
	readingDirection: ReadingDirection;
	/** Hide Obsidian's tab bar and title along with the reader's toolbar. */
	fullScreen: boolean;
	/** Draw pages with pageLook instead of as the file has them. */
	enhancePages: boolean;
	pageLook: PageLookSettings;
	/** "<source>:<comic id>" -> vault paths of the files downloaded for it. */
	downloads: Record<string, string[]>;
	/** "<source>:<comic id>" -> details of a downloaded comic. */
	library: Record<string, LibraryEntry>;
	/** Vault path -> last page read (0-based). */
	progress: Record<string, number>;
	/** Downloads not finished yet, in the order they run. */
	queue: QueuedDownload[];
}

export const DEFAULT_SETTINGS: ComicDownloaderSettings = {
	comicsFolder: "Comics",
	sourceId: "internet-archive",
	filters: {},
	browserTab: "browse",
	installedSort: "recent",
	searchScope: "golden-age",
	resultsPerPage: 20,
	fitMode: "page",
	readingDirection: "ltr",
	fullScreen: true,
	enhancePages: false,
	pageLook: DEFAULT_PAGE_LOOK,
	downloads: {},
	library: {},
	progress: {},
	queue: [],
};

export class ComicDownloaderSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ComicDownloaderPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Comics folder")
			.setDesc("Downloaded comics are saved here. The folder is created when needed.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.comicsFolder)
					.setValue(settings.comicsFolder)
					.onChange(async (value) => {
						settings.comicsFolder = value.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.comicsFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Comics to search")
			.setDesc(
				"Licences on the Internet Archive are set by whoever uploaded the item. " +
					"The golden age set is the most reliable; with the wider options, check the licence on each card.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("golden-age", "Golden age comics (public domain era)")
					.addOption("open", "All comics marked public domain or Creative Commons")
					.addOption("public-domain", "All comics marked public domain")
					.setValue(settings.searchScope)
					.onChange(async (value) => {
						settings.searchScope = value as SearchScope;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Results per page")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ "10": "10", "20": "20", "50": "50" })
					.setValue(String(settings.resultsPerPage))
					.onChange(async (value) => {
						settings.resultsPerPage = Number(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Page fit")
			.setDesc("How the reader sizes each page. You can also switch this from the reader's toolbar.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("page", "Whole page")
					.addOption("width", "Fit width")
					.setValue(settings.fitMode)
					.onChange(async (value) => {
						settings.fitMode = value as FitMode;
						await this.plugin.saveSettings();
						this.plugin.refreshReaders();
					}),
			);

		new Setting(containerEl)
			.setName("Reading direction")
			.setDesc("Right to left swaps the tap zones and arrow keys, for manga.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("ltr", "Left to right")
					.addOption("rtl", "Right to left")
					.setValue(settings.readingDirection)
					.onChange(async (value) => {
						settings.readingDirection = value as ReadingDirection;
						await this.plugin.saveSettings();
						this.plugin.refreshReaders();
					}),
			);

		new Setting(containerEl)
			.setName("Full screen")
			.setDesc("Tapping the middle of the page hides Obsidian's tab bar and title along with the reader's toolbar, so the page gets the whole screen.")
			.addToggle((toggle) =>
				toggle.setValue(settings.fullScreen).onChange(async (value) => {
					settings.fullScreen = value;
					await this.plugin.saveSettings();
					this.plugin.updateFullScreen();
				}),
			);

		new Setting(containerEl)
			.setName("Colours and sharpness")
			.setDesc(
				"For colour e-ink screens, which show pages paler and softer than the file. " +
					"Turn it on with the palette button in the reader's toolbar, and fine-tune it with the sliders button next to it while you look at a page.",
			);
	}
}
