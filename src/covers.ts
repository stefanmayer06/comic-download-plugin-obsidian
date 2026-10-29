import { App, TFile } from "obsidian";
import { log } from "./log";
import { READER_EXTENSIONS } from "./reader/ComicReaderView";
import { openPages } from "./reader/pages";
import { errorMessage } from "./util";

/** Covers are saved big enough to fill this box: three times a card's cover, so they stay sharp. */
const COVER_WIDTH = 288;
const COVER_HEIGHT = 432;

/**
 * Pictures of the first page of comics in the vault, for the Installed
 * page. Each is made once, by opening the comic, and kept as a small JPEG
 * in the plugin folder. That way covers show offline, and for comics put in
 * the folder by hand or downloaded before comic details were saved.
 */
export class CoverCache {
	/** Cover file -> its URL, or null if none could be made, for covers asked for since the plugin started. */
	private covers = new Map<string, Promise<string | null>>();
	/** Cover files waiting their turn to be made. */
	private waiting = new Set<string>();
	/** Raised by cancelWaiting(), so covers waiting from before are skipped. */
	private generation = 0;
	/** Covers are made one at a time: each holds a whole comic in memory. */
	private last: Promise<unknown> = Promise.resolve();

	constructor(
		private app: App,
		private folder: string,
	) {}

	/** The URL of a comic's cover, made first if needed. Null if the comic can't be opened. */
	get(file: TFile): Promise<string | null> {
		const path = this.pathFor(file);
		let cover = this.covers.get(path);
		if (!cover) {
			cover = this.find(file, path);
			this.covers.set(path, cover);
		}
		return cover;
	}

	/** Drops covers that haven't started, e.g. when the menu closes. They are made when next asked for. */
	cancelWaiting(): void {
		this.generation++;
		for (const path of this.waiting) this.covers.delete(path);
		this.waiting.clear();
	}

	/** Deletes the covers of comics that are no longer in the vault or have changed. */
	async prune(): Promise<void> {
		const { adapter } = this.app.vault;
		try {
			if (!(await adapter.exists(this.folder))) return;
			const keep = new Set(
				this.app.vault
					.getFiles()
					.filter((file) => READER_EXTENSIONS.includes(file.extension))
					.map((file) => this.pathFor(file)),
			);
			const stale = (await adapter.list(this.folder)).files.filter((path) => !keep.has(path));
			for (const path of stale) await adapter.remove(path);
			if (stale.length > 0) log.info(`Deleted ${stale.length} covers of comics no longer in the vault`);
		} catch (error) {
			log.warn("Could not tidy up the saved covers", error);
		}
	}

	/** Named after the comic's path, size and modification time, so a changed comic gets a new cover. */
	private pathFor(file: TFile): string {
		const name = [hash(file.path), file.stat.size, Math.round(file.stat.mtime)].map((part) => part.toString(36)).join("-");
		return `${this.folder}/${name}.jpg`;
	}

	private async find(file: TFile, path: string): Promise<string | null> {
		const { adapter } = this.app.vault;
		if (!(await adapter.exists(path))) {
			const generation = this.generation;
			this.waiting.add(path);
			const made = this.last.then(() => {
				if (generation !== this.generation) return false;
				this.waiting.delete(path);
				return this.make(file, path);
			});
			this.last = made;
			if (!(await made)) return null;
		}
		return adapter.getResourcePath(path);
	}

	/** Opens the comic and saves its first page, shrunk. Returns whether that worked. */
	private async make(file: TFile, path: string): Promise<boolean> {
		const { adapter } = this.app.vault;
		const started = Date.now();
		try {
			const pages = await openPages(file.extension, await this.app.vault.readBinary(file));
			try {
				const cover = await shrink(await pages.getPage(0));
				if (!(await adapter.exists(this.folder))) await adapter.mkdir(this.folder);
				await adapter.writeBinary(path, cover);
			} finally {
				pages.destroy();
			}
			log.info(`Made a cover for ${file.path} in ${Date.now() - started} ms`);
			return true;
		} catch (error) {
			log.warn(`Could not make a cover for ${file.path}: ${errorMessage(error)}`);
			return false;
		}
	}
}

/** Redraws a page as a JPEG just big enough to fill the cover box; the card trims what overflows. */
async function shrink(page: Blob): Promise<ArrayBuffer> {
	const image = await createImageBitmap(page);
	const scale = Math.min(1, Math.max(COVER_WIDTH / image.width, COVER_HEIGHT / image.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(image.width * scale));
	canvas.height = Math.max(1, Math.round(image.height * scale));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas is not available");
	// JPEG has no transparency, so see-through parts would turn black.
	context.fillStyle = "#fff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.imageSmoothingQuality = "high";
	context.drawImage(image, 0, 0, canvas.width, canvas.height);
	image.close();
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Could not draw the cover"))), "image/jpeg", 0.85),
	);
	return blob.arrayBuffer();
}

/** FNV-1a: a short number that stands for a string. */
function hash(text: string): number {
	let value = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
	return value >>> 0;
}
