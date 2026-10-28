import { requestUrl, RequestUrlResponse } from "obsidian";
import { log } from "./log";
import { errorMessage, formatBytes, htmlToText } from "./util";

/** An error response, e.g. a 404 or a 502. */
export class HttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/**
 * Fetches a URL with Obsidian's requestUrl (which follows redirects) and
 * writes the request and its outcome to the plugin log. Failures say which
 * host answered what, e.g. `getcomics.org answered with HTTP 403 ("Just a moment...")`.
 */
export async function fetchUrl(url: string, headers: Record<string, string> = {}): Promise<RequestUrlResponse> {
	const host = hostOf(url);
	const started = Date.now();
	const sent = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
	log.info(`GET ${url}${sent.length > 0 ? ` (${sent.join(", ")})` : ""}`);

	let response: RequestUrlResponse;
	try {
		response = await requestUrl({ url, headers, throw: false });
	} catch (error) {
		log.error(`No response from ${host} after ${secondsSince(started)}`, error);
		throw new Error(`Could not connect to ${host} (${errorMessage(error)})`);
	}

	const type = responseHeader(response.headers, "content-type") || "no content type";
	log.info(`${host} answered with HTTP ${response.status} in ${secondsSince(started)}: ${type}, ${formatBytes(response.arrayBuffer.byteLength)}`);
	if (response.status >= 400) {
		const title = pageTitle(response);
		log.error(`Response from ${host}:`, bodyPreview(response));
		throw new HttpError(`${host} answered with HTTP ${response.status}${title ? ` ("${title}")` : ""}`, response.status);
	}
	return response;
}

/** Like fetchUrl, for APIs that answer with JSON. */
export async function fetchJson(url: string): Promise<unknown> {
	return readJson(url, await fetchUrl(url));
}

/** Parses a JSON response, logging what came back when it isn't JSON. */
export function readJson(url: string, response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch {
		const title = pageTitle(response);
		log.error(`Expected JSON from ${hostOf(url)}, got:`, bodyPreview(response));
		throw new Error(`${hostOf(url)} did not answer with data${title ? ` but with a page titled "${title}"` : ""}`);
	}
}

export function responseHeader(headers: Record<string, string>, name: string): string {
	const key = Object.keys(headers).find((header) => header.toLowerCase() === name);
	return key ? headers[key] : "";
}

/** Title of an HTML response, e.g. a Cloudflare check page's "Just a moment...". */
export function pageTitle(response: RequestUrlResponse): string {
	if (!/html/i.test(responseHeader(response.headers, "content-type"))) return "";
	const match = response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? htmlToText(match[1]).slice(0, 100) : "";
}

/** The start of a text response, to log what a server sent instead of a comic. */
export function bodyPreview(response: RequestUrlResponse): string {
	const type = responseHeader(response.headers, "content-type");
	if (!/text|html|json|xml/i.test(type)) return `(${type || "no content type"}, ${formatBytes(response.arrayBuffer.byteLength)})`;
	const text = /html/i.test(type) ? visibleText(response.text) : response.text.replace(/\s+/g, " ").trim();
	return text.length > 500 ? `${text.slice(0, 500)}…` : text || "(empty)";
}

/** The text a page shows, without its scripts and styles. */
function visibleText(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	doc.querySelectorAll("script, style, noscript, template, svg").forEach((element) => element.remove());
	return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function secondsSince(started: number): string {
	return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}
