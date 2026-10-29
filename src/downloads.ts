import { Notice } from "obsidian";
import { downloadComic, SavedPieces } from "./downloader";
import { log } from "./log";
import type ComicDownloaderPlugin from "./main";
import type { QueuedDownload } from "./settings";
import type { ComicFile, ComicSummary } from "./sources/types";
import { addLink, showErrorNotice, showSavedNotice } from "./ui/notices";
import { errorMessage, formatBytes } from "./util";

interface Download {
	/** What is kept in the plugin's data while the download is queued. */
	entry: QueuedDownload;
	pieces: SavedPieces;
	/** Short progress shown on the comic's card, e.g. "Queued" or "45%". */
	status: string;
	/** How far it has got, e.g. "45% of 370 MB", or "" before the first piece. */
	progress: string;
	started: boolean;
	cancelled: boolean;
	notice: Notice;
}

/**
 * Runs downloads one after another, apart from the download menu, so they
 * carry on after the menu is closed. Each download shows its progress in a
 * notice, and another notice says when it has finished. One at a time keeps
 * memory use down on phones and tablets.
 *
 * The queue is kept in the plugin's data and each download's pieces in the
 * plugin folder, so downloads carry on from where they stopped when
 * Obsidian is opened again.
 */
export class DownloadQueue {
	private downloads: Download[] = [];
	private last: Promise<void>;
	private listeners = new Set<() => void>();
	/** Set when the plugin unloads: downloads stop where they are, to carry on at the next start. */
	private stopped = false;

	constructor(
		private plugin: ComicDownloaderPlugin,
		/** Holds a folder of pieces for each download that has started. */
		private folder: string,
	) {
		// Downloads wait for the vault to be ready, as they look for files already in it.
		this.last = new Promise((resolve) => plugin.app.workspace.onLayoutReady(() => resolve()));
		const saved = plugin.settings.queue;
		if (saved.length > 0) log.info(`Carrying on with ${saved.length} download${saved.length === 1 ? "" : "s"} from last time`);
		for (const entry of saved) this.enqueue(entry);
	}

	/** Progress of a comic that is downloading or waiting its turn, otherwise null. */
	statusOf(comic: ComicSummary): string | null {
		return this.downloads.find((download) => isSameComic(download.entry.comic, comic))?.status ?? null;
	}

	/** Downloads running or waiting their turn, in order. */
	list(): { name: string; status: string; cancel: () => void }[] {
		return this.downloads.map((download) => ({ name: download.entry.name, status: download.status, cancel: () => this.cancel(download) }));
	}

	/** Calls `listener` whenever a download starts, progresses or ends. Returns a function that stops it. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	add(comic: ComicSummary, name: string, file: ComicFile): void {
		if (this.downloads.some((download) => isSameComic(download.entry.comic, comic) && download.entry.file.url === file.url)) {
			new Notice(`"${name}" is already downloading.`);
			return;
		}
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.enqueue({ id, comic, name, file });
		void this.save();
	}

	/**
	 * Stops every download where it is, e.g. when the plugin is turned off or
	 * updated. They stay queued, with the pieces fetched so far, and carry on
	 * when the plugin starts again. Nothing is saved after this, so it can't
	 * overwrite what the plugin saves when it starts again.
	 */
	stopAll(): void {
		this.stopped = true;
		for (const download of this.downloads) download.notice.hide();
	}

	/** Deletes the pieces of downloads that are no longer queued, e.g. ones whose clean-up failed. */
	async prune(): Promise<void> {
		const { adapter } = this.plugin.app.vault;
		try {
			if (!(await adapter.exists(this.folder))) return;
			const keep = new Set(this.downloads.map((download) => download.pieces.folder));
			const stale = (await adapter.list(this.folder)).folders.filter((path) => !keep.has(path));
			for (const path of stale) await adapter.rmdir(path, true);
			if (stale.length > 0) log.info(`Deleted the pieces of ${stale.length} download${stale.length === 1 ? "" : "s"} no longer queued`);
		} catch (error) {
			log.warn("Could not tidy up the pieces of unfinished downloads", error);
		}
	}

	private enqueue(entry: QueuedDownload): void {
		const ahead = this.downloads.length;
		const download: Download = {
			entry,
			pieces: new SavedPieces(this.plugin.app.vault.adapter, `${this.folder}/${entry.id}`),
			status: ahead > 0 ? "Queued" : "Starting…",
			progress: "",
			started: false,
			cancelled: false,
			notice: new Notice("", 0),
		};
		this.downloads.push(download);
		if (ahead > 0) {
			log.info(`Queued "${entry.name}" behind ${ahead} other download${ahead === 1 ? "" : "s"}`);
			this.update(download, "Queued", `waiting for ${ahead} other download${ahead === 1 ? "" : "s"} to finish`);
		} else {
			this.update(download, "Starting…", "starting.");
		}
		this.last = this.last.then(() => this.run(download));
	}

	private async run(download: Download): Promise<void> {
		if (this.stopped || !this.downloads.includes(download)) return;
		const { entry } = download;
		const { comic, name, file } = entry;
		const resuming = entry.found !== undefined;
		download.started = true;
		this.update(download, "Starting…", resuming ? "carrying on from where it stopped." : "starting. You'll get a notice when it's done.");
		// Time left is worked out from what this run has fetched, so a download
		// that carries on doesn't count what it had before as fetched in no time.
		let from: { time: number; received: number } | null = resuming ? null : { time: Date.now(), received: 0 };
		try {
			const saved = await downloadComic(this.plugin.app, this.plugin.settings.comicsFolder, name, file, {
				pieces: download.pieces,
				found: entry.found,
				onFound: (found) => {
					entry.found = found;
					return this.save();
				},
				onProgress: (received, total) => {
					if (download.cancelled || this.stopped) return;
					from ??= { time: Date.now(), received };
					const percent = Math.floor((received / total) * 100);
					download.progress = `${percent}% of ${formatBytes(total)}`;
					const fetched = received - from.received;
					const left = fetched > 0 ? `, ${timeLeft(((Date.now() - from.time) / 1000 / fetched) * (total - received))}` : "";
					this.update(download, `${percent}%`, `${download.progress}${left}`);
				},
				onWaiting: (reason, seconds) => {
					if (download.cancelled || this.stopped) return;
					const sofar = download.progress ? `${download.progress}. ` : "";
					this.update(download, "Waiting…", `${sofar}${reason}, trying again in ${seconds} s.`);
				},
				isStopped: () => download.cancelled || this.stopped,
			});
			// The next start finds the file in the vault and records it.
			if (this.stopped) return;
			await this.plugin.recordDownload(comic, saved.path);
			download.notice.hide();
			showSavedNotice(this.plugin, saved);
		} catch (error) {
			if (this.stopped) {
				log.info(`Stopped downloading "${name}" with the plugin; it carries on from there when the plugin starts again`);
				return;
			}
			download.notice.hide();
			if (download.cancelled) {
				log.info(`Download of "${name}" cancelled`);
				new Notice(`Download of "${name}" cancelled.`);
			} else {
				log.error(`Download of "${name}" failed`, error);
				showErrorNotice(this.plugin, `Download of "${name}" failed: ${errorMessage(error)}.`);
			}
		}
		this.remove(download);
	}

	/** A running download stops after the piece it is fetching; a waiting one is dropped at once. */
	private cancel(download: Download): void {
		download.cancelled = true;
		if (download.started) {
			download.status = "Cancelling…";
			this.changed();
			return;
		}
		log.info(`Download of "${download.entry.name}" cancelled before it started`);
		download.notice.hide();
		this.remove(download);
	}

	private update(download: Download, status: string, detail: string): void {
		download.status = status;
		download.notice.setMessage(
			createFragment((frag) => {
				frag.appendText(`Downloading "${download.entry.name}": ${detail} `);
				addLink(frag, "Cancel", () => this.cancel(download));
			}),
		);
		this.changed();
	}

	/** Takes a download off the queue for good, with its pieces. */
	private remove(download: Download): void {
		this.downloads = this.downloads.filter((other) => other !== download);
		void this.save();
		void download.pieces.clear();
		this.changed();
	}

	/** Keeps the queue in the plugin's data, so it carries on after Obsidian restarts. */
	private save(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.plugin.settings.queue = this.downloads.map((download) => download.entry);
		return this.plugin.saveSettings();
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
