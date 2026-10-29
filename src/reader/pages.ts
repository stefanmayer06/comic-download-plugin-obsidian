import { loadPdfJs } from "obsidian";
import type { FileHeader } from "node-unrar-js";
import { log } from "../log";
import { detectComicExtension, fileExtension, naturalCompare } from "../util";
import { RarArchive } from "./rar";
import { ZipArchive, ZipEntry } from "./zip";

const IMAGE_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
};

/** Whether an archive entry is a page: an image, not a folder, hidden file or macOS extra. */
function isPage(name: string): boolean {
	const base = name.split("/").pop() ?? "";
	return !name.endsWith("/") && !name.startsWith("__MACOSX/") && !base.startsWith(".") && fileExtension(base) in IMAGE_TYPES;
}

/** How many pages around the current one stay unpacked. */
const KEEP_AROUND = 3;

/**
 * The pages of one comic. Pages are unpacked lazily, and only the pages
 * near the one being read are kept in memory.
 */
export abstract class PageSource {
	abstract readonly pageCount: number;
	private images = new Map<number, Promise<Blob>>();

	protected abstract renderPage(index: number): Promise<Blob>;

	/** The page's image file, e.g. a JPEG. */
	getPage(index: number): Promise<Blob> {
		let image = this.images.get(index);
		if (!image) {
			image = this.renderPage(index);
			// A failed page should be retried next time, not cached.
			image.catch(() => this.images.delete(index));
			this.images.set(index, image);
		}
		for (const page of this.images.keys()) {
			if (Math.abs(page - index) > KEEP_AROUND) this.images.delete(page);
		}
		return image;
	}

	destroy(): void {
		this.images.clear();
	}
}

export class CbzPages extends PageSource {
	private archive: ZipArchive;
	private pages: ZipEntry[];

	constructor(data: ArrayBuffer) {
		super();
		this.archive = new ZipArchive(data);
		this.pages = this.archive.entries.filter((entry) => isPage(entry.name)).sort((a, b) => naturalCompare(a.name, b.name));
		if (this.pages.length === 0) throw new Error("This CBZ file contains no images");
	}

	get pageCount(): number {
		return this.pages.length;
	}

	protected async renderPage(index: number): Promise<Blob> {
		const entry = this.pages[index];
		return new Blob([this.archive.read(entry)], { type: IMAGE_TYPES[fileExtension(entry.name)] });
	}
}

export class CbrPages extends PageSource {
	private constructor(
		private archive: RarArchive,
		private pages: FileHeader[],
	) {
		super();
	}

	static async open(data: ArrayBuffer): Promise<CbrPages> {
		const archive = await RarArchive.open(data);
		const pages = archive.entries.filter((entry) => !entry.flags.directory && isPage(entry.name)).sort((a, b) => naturalCompare(a.name, b.name));
		if (pages.length === 0) throw new Error("This CBR file contains no images");
		// Pages of a solid archive can only be unpacked in order, so later pages take longer.
		if (archive.isSolid) log.info("This CBR is a solid archive: pages further in take longer to open");
		return new CbrPages(archive, pages);
	}

	get pageCount(): number {
		return this.pages.length;
	}

	protected async renderPage(index: number): Promise<Blob> {
		const entry = this.pages[index];
		return new Blob([await this.archive.read(entry)], { type: IMAGE_TYPES[fileExtension(entry.name)] });
	}
}

/** Long side of a rendered PDF page in pixels: sharp on tablets, cheap enough on phones. */
const PDF_TARGET_PIXELS = 2200;

export class PdfPages extends PageSource {
	// pdf.js ships inside Obsidian without type definitions.
	private constructor(private doc: any) {
		super();
	}

	static async open(data: ArrayBuffer): Promise<PdfPages> {
		const pdfjs = await loadPdfJs();
		const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
		return new PdfPages(doc);
	}

	get pageCount(): number {
		return this.doc.numPages;
	}

	protected async renderPage(index: number): Promise<Blob> {
		const page = await this.doc.getPage(index + 1);
		const base = page.getViewport({ scale: 1 });
		const scale = PDF_TARGET_PIXELS / Math.max(base.width, base.height);
		const viewport = page.getViewport({ scale });
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(viewport.width);
		canvas.height = Math.round(viewport.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas is not available");
		await page.render({ canvasContext: context, canvas, viewport }).promise;
		page.cleanup();
		return new Promise((resolve, reject) =>
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not draw PDF page"))), "image/jpeg", 0.9),
		);
	}

	destroy(): void {
		super.destroy();
		void this.doc.destroy();
	}
}

export async function openPages(extension: string, data: ArrayBuffer): Promise<PageSource> {
	// Go by the contents: plenty of ".cbr" files are really ZIPs, and some ".cbz" files RARs.
	const format = detectComicExtension(data) ?? extension;
	if (format !== extension) log.info(`This .${extension} file is really a ${format.toUpperCase()}; opening it as one`);
	if (format === "cbz") return new CbzPages(data);
	if (format === "cbr") return CbrPages.open(data);
	if (format === "pdf") return PdfPages.open(data);
	throw new Error(`.${extension} files can't be opened by the comic reader`);
}
