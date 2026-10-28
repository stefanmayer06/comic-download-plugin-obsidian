import { Notice, TFile } from "obsidian";
import type ComicDownloaderPlugin from "../main";

/** A notice with a link to the log, which has the details. */
export function showErrorNotice(plugin: ComicDownloaderPlugin, message: string): void {
	const fragment = createFragment((frag) => {
		frag.appendText(`${message} `);
		addLink(frag, "Show log", () => plugin.showLog());
	});
	new Notice(fragment, 15000);
}

/** Says a download has finished. It stays until tapped, so it isn't missed. */
export function showSavedNotice(plugin: ComicDownloaderPlugin, file: TFile): void {
	const fragment = createFragment((frag) => {
		frag.appendText(`Download finished: ${file.path}. `);
		if (file.extension === "cbr") {
			frag.appendText("CBR files can't be opened by the reader yet.");
			return;
		}
		addLink(frag, "Read now", () => {
			plugin.browser?.close();
			void plugin.openInReader(file);
		});
	});
	new Notice(fragment, 0);
}

export function addLink(parent: DocumentFragment, text: string, onClick: () => void): void {
	const link = parent.createEl("a", { text, href: "#" });
	link.addEventListener("click", (event) => {
		event.preventDefault();
		onClick();
	});
}
