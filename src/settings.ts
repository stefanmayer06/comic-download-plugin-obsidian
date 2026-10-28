import { App, PluginSettingTab, Setting } from "obsidian";
import type ComicDownloaderPlugin from "./main";
import type { SearchScope } from "./sources/internetArchive";

export type FitMode = "page" | "width";
export type ReadingDirection = "ltr" | "rtl";

export interface ComicDownloaderSettings {
	comicsFolder: string;
	sourceId: string;
	searchScope: SearchScope;
	resultsPerPage: number;
	fitMode: FitMode;
	readingDirection: ReadingDirection;
	/** "<source>:<comic id>" -> vault paths of the files downloaded for it. */
	downloads: Record<string, string[]>;
	/** Vault path -> last page read (0-based). */
	progress: Record<string, number>;
}

export const DEFAULT_SETTINGS: ComicDownloaderSettings = {
	comicsFolder: "Comics",
	sourceId: "internet-archive",
	searchScope: "golden-age",
	resultsPerPage: 20,
	fitMode: "page",
	readingDirection: "ltr",
	downloads: {},
	progress: {},
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
	}
}
