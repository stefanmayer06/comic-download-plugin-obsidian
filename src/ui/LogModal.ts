import { App, ButtonComponent, Modal, Notice } from "obsidian";
import { log } from "../log";

const EMPTY = "Nothing has been logged yet. Search for or download a comic, then open the log again.";

/** Shows the plugin log, newest lines at the bottom, with copy and clear buttons. */
export class LogModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("comic-log-modal");
		this.titleEl.setText("Comic Downloader log");
		const { contentEl } = this;

		const text = log.text();
		const logEl = contentEl.createEl("pre", { cls: "comic-log", text: text || EMPTY });

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText("Copy")
			.setCta()
			.onClick(async () => {
				try {
					await navigator.clipboard.writeText(log.text());
					new Notice("Log copied to the clipboard.");
				} catch (error) {
					console.error("Comic Downloader: could not copy the log", error);
					new Notice("Could not copy the log. Select the text and copy it instead.");
				}
			});
		new ButtonComponent(buttons).setButtonText("Clear").onClick(async () => {
			await log.clear();
			logEl.setText(EMPTY);
		});

		// Start at the newest lines.
		window.setTimeout(() => (logEl.scrollTop = logEl.scrollHeight), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
