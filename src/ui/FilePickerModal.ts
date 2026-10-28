import { App, SuggestModal } from "obsidian";
import type { ComicFile } from "../sources/types";
import { formatBytes } from "../util";

/** Lets the user pick one issue when a comic comes with several files. */
export class FilePickerModal extends SuggestModal<ComicFile> {
	private chosen = false;

	constructor(
		app: App,
		private files: ComicFile[],
		private isDownloaded: (file: ComicFile) => boolean,
		private onPick: (file: ComicFile | null) => void,
	) {
		super(app);
		this.setPlaceholder(`Pick an issue (${files.length} available)`);
	}

	getSuggestions(query: string): ComicFile[] {
		const needle = query.toLowerCase();
		return this.files.filter((file) => file.label.toLowerCase().includes(needle));
	}

	renderSuggestion(file: ComicFile, el: HTMLElement): void {
		el.addClass("comic-file-suggestion");
		el.createDiv({ text: file.label, cls: "comic-file-suggestion-title" });
		const details = [file.extension.toUpperCase()];
		if (file.size) details.push(formatBytes(file.size));
		if (this.isDownloaded(file)) details.push("downloaded");
		el.createDiv({ text: details.join(" · "), cls: "comic-file-suggestion-meta" });
	}

	onChooseSuggestion(file: ComicFile): void {
		this.chosen = true;
		this.onPick(file);
	}

	onClose(): void {
		super.onClose();
		// onChooseSuggestion runs after onClose, so wait a tick before reporting a cancel.
		window.setTimeout(() => {
			if (!this.chosen) this.onPick(null);
		}, 0);
	}
}
