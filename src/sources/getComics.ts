import { fetchJson, fetchUrl, readJson, responseHeader } from "../http";
import { log } from "../log";
import { fileExtension, htmlToText, naturalCompare } from "../util";
import { ComicFile, ComicSource, ComicSummary, filterValue, FilterValues, SearchFilter, SearchPage } from "./types";

const SITE_URL = "https://getcomics.org/";
const API_URL = `${SITE_URL}wp-json/wp/v2/posts`;
const DIRECT_LINK_LABEL = /^(download(?:\s+now)?|main\s+server|link\s+1)$/i;
const FORMATS: ComicFile["extension"][] = ["cbz", "pdf", "cbr"];

/** GetComics tags collected editions (TPBs, omnibuses) with this. */
const GRAPHIC_NOVEL_TAG = 10088;
/** News, Blog and Sponsored: posts that aren't comics. */
const NON_COMIC_CATEGORIES = [3033, 1, 4512];
/** DC, Marvel, Image and INDIE Week: weekly packs, ZIPs of many comics that can't be downloaded here. */
const WEEKLY_PACK_TAGS = [176, 1237, 1702, 8622];

/**
 * Publishers to filter by. GetComics files DC and Marvel under categories
 * and tags most others; "Other publishers" is its category for everything
 * else. IDs come from /wp-json/wp/v2/categories and /wp-json/wp/v2/tags.
 */
const PUBLISHERS: { label: string; category?: number; tag?: number }[] = [
	{ label: "DC Comics", category: 2 },
	{ label: "Marvel Comics", category: 3 },
	{ label: "Image Comics", tag: 215 },
	{ label: "2000 AD", tag: 1270 },
	{ label: "Ablaze", tag: 10320 },
	{ label: "Abstract Studio", tag: 3657 },
	{ label: "AfterShock Comics", tag: 3283 },
	{ label: "Ahoy Comics", tag: 8820 },
	{ label: "Antarctic Press", tag: 1434 },
	{ label: "Archie", tag: 819 },
	{ label: "AWA Studios", tag: 10462 },
	{ label: "Black Mask Studios", tag: 3575 },
	{ label: "Boom! Studios", tag: 1408 },
	{ label: "DSTLRY", tag: 13644 },
	{ label: "Dynamite Entertainment", tag: 314 },
	{ label: "Europe Comics", tag: 3751 },
	{ label: "Fantagraphics", tag: 2406 },
	{ label: "Humanoids", tag: 1890 },
	{ label: "IDW", tag: 305 },
	{ label: "Mad Cave Studios", tag: 10080 },
	{ label: "Oni Press", tag: 1010 },
	{ label: "Rebellion", tag: 6680 },
	{ label: "Scout Comics", tag: 7934 },
	{ label: "Valiant", tag: 1816 },
	{ label: "Vertigo", tag: 298 },
	{ label: "Zenescope", tag: 329 },
	{ label: "Other publishers", category: 212 },
];

const SORTS: Record<string, { orderby: string; order: "asc" | "desc" }> = {
	newest: { orderby: "date", order: "desc" },
	oldest: { orderby: "date", order: "asc" },
	"title-az": { orderby: "title", order: "asc" },
	"title-za": { orderby: "title", order: "desc" },
	relevance: { orderby: "relevance", order: "desc" },
};

interface WordPressPost {
	id: number;
	link: string;
	categories?: number[];
	tags?: number[];
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
	filters: SearchFilter[] = [
		{
			id: "publisher",
			name: "Publisher",
			options: [{ value: "", label: "All publishers" }, ...PUBLISHERS.map((publisher) => ({ value: publisherValue(publisher), label: publisher.label }))],
		},
		{
			id: "type",
			name: "Type",
			options: [
				{ value: "all", label: "All types" },
				{ value: "comics", label: "Comics" },
				{ value: "graphic-novels", label: "Graphic novels" },
			],
		},
		{
			id: "sort",
			name: "Sort",
			options: [
				{ value: "newest", label: "Newest first" },
				{ value: "oldest", label: "Oldest first" },
				{ value: "title-az", label: "Title A–Z" },
				{ value: "title-za", label: "Title Z–A" },
				{ value: "relevance", label: "Best match" },
			],
		},
	];

	constructor(private getSettings: () => { resultsPerPage: number }) {}

	async search(query: string, page: number, filters: FilterValues): Promise<SearchPage> {
		const rows = this.getSettings().resultsPerPage;
		const params = new URLSearchParams({
			page: String(page),
			per_page: String(rows),
			_fields: "id,link,title,excerpt,jetpack_featured_media_url,categories,tags",
		});
		if (query.trim()) params.set("search", query.trim());

		const publisher = PUBLISHERS.find((candidate) => publisherValue(candidate) === filterValue(this.filters, filters, "publisher"));
		if (publisher?.category) params.set("categories", String(publisher.category));
		else params.set("categories_exclude", NON_COMIC_CATEGORIES.join(","));
		const tags = publisher?.tag ? [publisher.tag] : [];
		const excludedTags = [...WEEKLY_PACK_TAGS];
		const type = filterValue(this.filters, filters, "type");
		if (type === "graphic-novels") tags.push(GRAPHIC_NOVEL_TAG);
		if (type === "comics") excludedTags.push(GRAPHIC_NOVEL_TAG);
		params.set("tags_exclude", excludedTags.join(","));
		if (tags.length > 0) {
			// Posts must carry every tag, e.g. both "Image Comics" and "TPB".
			params.set("tags[terms]", tags.join(","));
			params.set("tags[operator]", "AND");
		}
		// "Best match" ranks posts by the search words, so it needs some.
		const sort = SORTS[filterValue(this.filters, filters, "sort")];
		const { orderby, order } = sort.orderby === "relevance" && !query.trim() ? SORTS.newest : sort;
		params.set("orderby", orderby);
		params.set("order", order);

		const url = `${API_URL}?${params.toString()}`;
		const response = await fetchUrl(url);
		const posts = readJson(url, response) as WordPressPost[];
		if (!Array.isArray(posts)) {
			log.error("GetComics sent something other than a list of posts:", posts);
			throw new Error("Unexpected response from GetComics");
		}

		const results = posts.map((post) => ({
			id: String(post.id),
			sourceId: this.id,
			name: htmlToText(post.title?.rendered ?? "") || `GetComics post ${post.id}`,
			author: "",
			publisher: publisherOf(post),
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
		const post = (await fetchJson(`${API_URL}/${encodeURIComponent(comic.id)}?${params.toString()}`)) as WordPressPost;
		const html = post?.content?.rendered;
		if (!html) {
			log.warn(`GetComics post ${comic.id} has no content`);
			return [];
		}

		const doc = new DOMParser().parseFromString(html, "text/html");
		const anchors = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")];
		const candidates = anchors.filter((anchor) => {
			const label = (anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim();
			return DIRECT_LINK_LABEL.test(label) && directDownloadUrl(anchor.getAttribute("href"));
		});
		const bodyText = htmlToText(html);
		const files: ComicFile[] = [];
		log.info(`GetComics post ${comic.id} has ${anchors.length} links, ${candidates.length} of them direct downloads`);
		if (candidates.length === 0) {
			const labels = anchors
				.filter((anchor) => /\/dls\//.test(anchor.getAttribute("href") ?? ""))
				.map((anchor) => (anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim());
			log.warn(
				labels.length > 0
					? `Its download links are all hosted elsewhere (${labels.join(", ")}), which isn't supported`
					: "It has no download links",
			);
		}

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
			if (!extension && relatedExtensions.includes("zip")) {
				log.info(`Skipping ${url}: its mirrors are ZIP files, which hold several comics`);
				continue;
			}

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

function publisherValue(publisher: { category?: number; tag?: number }): string {
	return publisher.category ? `category-${publisher.category}` : `tag-${publisher.tag}`;
}

/** Publisher tags are more specific than categories: a Vertigo comic is also filed under DC. */
function publisherOf(post: WordPressPost): string {
	const tagged = PUBLISHERS.find((publisher) => publisher.tag && post.tags?.includes(publisher.tag));
	const filed = PUBLISHERS.find((publisher) => publisher.category && publisher.label !== "Other publishers" && post.categories?.includes(publisher.category));
	return (tagged ?? filed)?.label ?? "";
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
