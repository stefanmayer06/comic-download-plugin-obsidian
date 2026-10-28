import { requestUrl } from "obsidian";
import { fileExtension, htmlToText, naturalCompare } from "../util";
import type { ComicFile, ComicSource, ComicSummary, SearchPage } from "./types";

const SITE_URL = "https://getcomics.org/";
const API_URL = `${SITE_URL}wp-json/wp/v2/posts`;
const DIRECT_LINK_LABEL = /^(download(?:\s+now)?|main\s+server|link\s+1)$/i;
const FORMATS: ComicFile["extension"][] = ["cbz", "pdf", "cbr"];

interface WordPressPost {
	id: number;
	link: string;
	title?: { rendered?: string };
	excerpt?: { rendered?: string };
	content?: { rendered?: string };
	jetpack_featured_media_url?: string;
}

/** Comics listed on GetComics, using its public WordPress API. */
export class GetComicsSource implements ComicSource {
	id = "getcomics";
	name = "GetComics";
	description = "Direct CBZ, CBR and PDF downloads are used when available.";

	constructor(private getSettings: () => { resultsPerPage: number }) {}

	async search(query: string, page: number): Promise<SearchPage> {
		const rows = this.getSettings().resultsPerPage;
		const params = new URLSearchParams({
			page: String(page),
			per_page: String(rows),
			_fields: "id,link,title,excerpt,jetpack_featured_media_url",
		});
		if (query.trim()) params.set("search", query.trim());

		const response = await requestUrl(`${API_URL}?${params.toString()}`);
		const posts = response.json as WordPressPost[];
		if (!Array.isArray(posts)) throw new Error("Unexpected response from GetComics");

		const results = posts.map((post) => ({
			id: String(post.id),
			sourceId: this.id,
			name: htmlToText(post.title?.rendered ?? "") || `GetComics post ${post.id}`,
			author: "",
			publisher: publisherFromUrl(post.link),
			description: htmlToText(post.excerpt?.rendered ?? ""),
			license: "",
			coverUrl: post.jetpack_featured_media_url || null,
			pageUrl: post.link,
		}));
		const totalPages = Number(responseHeader(response.headers, "x-wp-totalpages"));
		return {
			results,
			hasMore: Number.isFinite(totalPages) && totalPages > 0 ? page < totalPages : posts.length === rows,
		};
	}

	async listFiles(comic: ComicSummary): Promise<ComicFile[]> {
		const params = new URLSearchParams({ _fields: "content" });
		const response = await requestUrl(`${API_URL}/${encodeURIComponent(comic.id)}?${params.toString()}`);
		const post = response.json as WordPressPost;
		const html = post.content?.rendered;
		if (!html) return [];

		const doc = new DOMParser().parseFromString(html, "text/html");
		const anchors = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")];
		const candidates = anchors.filter((anchor) => {
			const label = (anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim();
			return DIRECT_LINK_LABEL.test(label) && directDownloadUrl(anchor.getAttribute("href"));
		});
		const bodyText = htmlToText(html);
		const files: ComicFile[] = [];

		for (const anchor of candidates) {
			const url = directDownloadUrl(anchor.getAttribute("href"));
			if (!url) continue;

			const item = anchor.closest("li");
			// A single issue usually has a row of mirrors. For collections, only
			// compare mirrors within the same issue's list item.
			const related = item ? [...item.querySelectorAll<HTMLAnchorElement>("a[href]")] : candidates.length === 1 ? anchors : [];
			const relatedExtensions = related.map((link) => extensionFromUrl(link.getAttribute("href") ?? ""));
			const extension = FORMATS.find((format) => relatedExtensions.includes(format));
			// A ZIP normally contains a set of issues rather than one readable comic.
			if (!extension && relatedExtensions.includes("zip")) continue;

			const contextText = item?.textContent ?? bodyText;
			files.push({
				label: labelFromItem(item) || comic.name,
				url,
				// GetComics files are CBZ/CBR; the downloader verifies the actual
				// signature and corrects this fallback when a mirror has no filename.
				extension: extension ?? "cbz",
				size: sizeFromText(contextText),
			});
		}

		const unique = new Map<string, ComicFile>();
		for (const file of files) unique.set(`${file.label}\n${file.url}`, file);
		return [...unique.values()].sort((a, b) => naturalCompare(a.label, b.label));
	}
}

function responseHeader(headers: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(headers).find((header) => header.toLowerCase() === name);
	return key ? headers[key] : "";
}

function publisherFromUrl(pageUrl: string): string {
	try {
		const section = new URL(pageUrl).pathname.split("/").filter(Boolean)[0];
		if (section === "dc") return "DC Comics";
		if (section === "marvel") return "Marvel Comics";
	} catch {
		// Keep the publisher empty if the source supplied a malformed URL.
	}
	return "";
}

/** Preserve opaque download tokens, including '+', '/', ':' and '='. */
function directDownloadUrl(href: string | null): string | null {
	if (!href) return null;
	const trimmed = href.trim();
	if (trimmed.startsWith("/dls/")) return `${SITE_URL}${trimmed.slice(1)}`;
	const https = trimmed.replace(/^http:\/\/getcomics\.org\//i, SITE_URL);
	return /^https:\/\/getcomics\.org\/dls\//i.test(https) ? https : null;
}

function extensionFromUrl(url: string): string {
	return fileExtension(url.split(/[?#]/, 1)[0]);
}

function labelFromItem(item: HTMLLIElement | null): string {
	if (!item) return "";
	const copy = item.cloneNode(true) as HTMLLIElement;
	copy.querySelectorAll("a").forEach((anchor) => anchor.remove());
	return (copy.textContent ?? "")
		.replace(/\s+/g, " ")
		.replace(/\s*\(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)\)/i, "")
		.replace(/[\s|:]+$/, "")
		.trim();
}

function sizeFromText(text: string): number | null {
	const match = text.match(/(?:Size\s*:\s*|\()\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\b/i);
	if (!match) return null;
	const units = ["B", "KB", "MB", "GB", "TB"];
	return Math.round(Number(match[1]) * 1024 ** units.indexOf(match[2].toUpperCase()));
}
