import { Notice } from "obsidian";
import { downloadComic } from "./downloader";
import { log } from "./log";
import type ComicDownloaderPlugin from "./main";
import type { ComicFile, ComicSummary } from "./sources/types";
import { addLink, showErrorNotice, showSavedNotice } from "./ui/notices";
import { errorMessage, formatBytes } from "./util";

interface Download {
	comic: ComicSummary;
	name: string;
	file: ComicFile;
	/** Short progress shown on the comic's card, e.g. "Queued" or "45%". */
	status: string;
	started: boolean;
	cancelled: boolean;
	notice: Notice;
}

/**
 * Runs downloads one after another, apart from the download menu, so they
 * carry on after the menu is closed. Each download shows its progress in a
 * notice, and another notice says when it has finished. One at a time keeps
 * memory use down on phones and tablets.
 */
export class DownloadQueue {
	private downloads: Download[] = [];
	private last: Promise<void> = Promise.resolve();
	private listeners = new Set<() => void>();

	constructor(private plugin: ComicDownloaderPlugin) {}

	/** Progress of a comic that is downloading or waiting its turn, otherwise null. */
	statusOf(comic: ComicSummary): string | null {
		return this.downloads.find((download) => isSameComic(download.comic, comic))?.status ?? null;
	}

	/** Calls `listener` whenever a download starts, progresses or ends. Returns a function that stops it. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	add(comic: ComicSummary, name: string, file: ComicFile): void {
		if (this.downloads.some((download) => isSameComic(download.comic, comic) && download.file.url === file.url)) {
			new Notice(`"${name}" is already downloading.`);
			return;
		}
		const ahead = this.downloads.length;
		const download: Download = {
			comic,
			name,
			file,
			status: ahead > 0 ? "Queued" : "Starting…",
			started: false,
			cancelled: false,
			notice: new Notice("", 0),
		};
		this.downloads.push(download);
		if (ahead > 0) {
			log.info(`Queued "${name}" behind ${ahead} other download${ahead === 1 ? "" : "s"}`);
			this.update(download, "Queued", `waiting for ${ahead} other download${ahead === 1 ? "" : "s"} to finish`);
		}
		this.last = this.last.then(() => this.run(download));
	}

	/** Stops every download, e.g. when the plugin is turned off. */
	cancelAll(): void {
		for (const download of [...this.downloads]) this.cancel(download);
	}

	private async run(download: Download): Promise<void> {
		if (!this.downloads.includes(download)) return;
		const { comic, name, file } = download;
		download.started = true;
		this.update(download, "Starting…", "starting. You'll get a notice when it's done.");
		const started = Date.now();
		try {
			const saved = await downloadComic(this.plugin.app, this.plugin.settings.comicsFolder, name, file, {
				onProgress: (received, total) => {
					if (download.cancelled) return;
					const percent = Math.floor((received / total) * 100);
					const secondsLeft = ((Date.now() - started) / 1000 / received) * (total - received);
					this.update(download, `${percent}%`, `${percent}% of ${formatBytes(total)}, ${timeLeft(secondsLeft)}`);
				},
				isCancelled: () => download.cancelled,
			});
			await this.plugin.recordDownload(comic, saved.path);
			download.notice.hide();
			showSavedNotice(this.plugin, saved);
		} catch (error) {
			download.notice.hide();
			if (download.cancelled) {
				log.info(`Download of "${name}" cancelled`);
				new Notice(`Download of "${name}" cancelled.`);
			} else {
				log.error(`Download of "${name}" failed`, error);
				showErrorNotice(this.plugin, `Download of "${name}" failed: ${errorMessage(error)}.`);
			}
		} finally {
			this.remove(download);
		}
	}

	/** A running download stops after the piece it is fetching; a waiting one is dropped at once. */
	private cancel(download: Download): void {
		download.cancelled = true;
		if (download.started) {
			download.status = "Cancelling…";
			this.changed();
			return;
		}
		log.info(`Download of "${download.name}" cancelled before it started`);
		download.notice.hide();
		this.remove(download);
	}

	private update(download: Download, status: string, detail: string): void {
		download.status = status;
		download.notice.setMessage(
			createFragment((frag) => {
				frag.appendText(`Downloading "${download.name}": ${detail} `);
				addLink(frag, "Cancel", () => this.cancel(download));
			}),
		);
		this.changed();
	}

	private remove(download: Download): void {
		this.downloads = this.downloads.filter((other) => other !== download);
		this.changed();
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}

function timeLeft(seconds: number): string {
	if (seconds < 60) return "less than a minute left";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `about ${minutes} min left`;
	return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function isSameComic(a: ComicSummary, b: ComicSummary): boolean {
	return a.sourceId === b.sourceId && a.id === b.id;
}
