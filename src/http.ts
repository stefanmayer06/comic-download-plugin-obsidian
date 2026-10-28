import { requestUrl, RequestUrlResponse } from "obsidian";
import { log } from "./log";
import { errorMessage, formatBytes, htmlToText } from "./util";

/**
 * Fetches a URL with Obsidian's requestUrl (which follows redirects) and
 * writes the request and its outcome to the plugin log. Failures say which
 * host answered what, e.g. `getcomics.org answered with HTTP 403 ("Just a moment...")`.
 */
export async function fetchUrl(url: string): Promise<RequestUrlResponse> {
	const host = hostOf(url);
	const started = Date.now();
	log.info(`GET ${url}`);

	let response: RequestUrlResponse;
	try {
		response = await requestUrl({ url, throw: false });
	} catch (error) {
		log.error(`No response from ${host} after ${secondsSince(started)}`, error);
		throw new Error(`Could not connect to ${host} (${errorMessage(error)})`);
	}

	const type = responseHeader(response.headers, "content-type") || "no content type";
	log.info(`${host} answered with HTTP ${response.status} in ${secondsSince(started)}: ${type}, ${formatBytes(response.arrayBuffer.byteLength)}`);
	if (response.status >= 400) {
		const title = pageTitle(response);
		log.error(`Response from ${host}:`, bodyPreview(response));
		throw new Error(`${host} answered with HTTP ${response.status}${title ? ` ("${title}")` : ""}`);
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
