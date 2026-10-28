import { loadPdfJs } from "obsidian";
import { fileExtension, naturalCompare } from "../util";
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

/** How many pages around the current one keep their decoded image. */
const KEEP_AROUND = 3;

/**
 * The pages of one comic. Pages are decoded lazily into object URLs, and
 * only the pages near the one being read are kept in memory.
 */
export abstract class PageSource {
	abstract readonly pageCount: number;
	private urls = new Map<number, Promise<string>>();

	protected abstract renderPage(index: number): Promise<Blob>;

	getPage(index: number): Promise<string> {
		let url = this.urls.get(index);
		if (!url) {
			url = this.renderPage(index).then((blob) => URL.createObjectURL(blob));
			// A failed page should be retried next time, not cached.
			url.catch(() => this.urls.delete(index));
			this.urls.set(index, url);
		}
		this.evictFarFrom(index);
		return url;
	}

	private evictFarFrom(index: number): void {
		for (const [page, url] of this.urls) {
			if (Math.abs(page - index) > KEEP_AROUND) {
				this.urls.delete(page);
				url.then((value) => URL.revokeObjectURL(value), () => undefined);
			}
		}
	}

	destroy(): void {
		for (const url of this.urls.values()) url.then((value) => URL.revokeObjectURL(value), () => undefined);
		this.urls.clear();
	}
}

export class CbzPages extends PageSource {
	private archive: ZipArchive;
	private pages: ZipEntry[];

	constructor(data: ArrayBuffer) {
		super();
		this.archive = new ZipArchive(data);
		this.pages = this.archive.entries
			.filter((entry) => {
				const base = entry.name.split("/").pop() ?? "";
				return (
					!entry.name.endsWith("/") &&
					!entry.name.startsWith("__MACOSX/") &&
					!base.startsWith(".") &&
					fileExtension(base) in IMAGE_TYPES
				);
			})
			.sort((a, b) => naturalCompare(a.name, b.name));
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
	if (extension === "cbz") return new CbzPages(data);
	if (extension === "pdf") return PdfPages.open(data);
	throw new Error(`.${extension} files can't be opened by the comic reader`);
}
