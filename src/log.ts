import { DataAdapter, moment } from "obsidian";
import { errorMessage } from "./util";

/** Older lines are dropped when the log is opened. */
const MAX_LINES = 2000;

type Level = "INFO" | "WARN" | "ERROR";

/**
 * Records what searches, downloads and the reader did, so failures can be
 * looked into with the "Show log" command instead of the developer console
 * (which mobile doesn't have). Lines are also appended to a file in the
 * plugin folder, so they survive a crash or restart.
 */
class PluginLog {
	private lines: string[] = [];
	private adapter: DataAdapter | null = null;
	private path = "";
	private writes: Promise<void> = Promise.resolve();

	async open(adapter: DataAdapter, path: string): Promise<void> {
		this.adapter = adapter;
		this.path = path;
		try {
			if (await adapter.exists(path)) {
				const saved = (await adapter.read(path)).split("\n").filter(Boolean);
				this.lines = [...saved, ...this.lines].slice(-MAX_LINES);
				if (saved.length > MAX_LINES) await adapter.write(path, this.text() + "\n");
			}
		} catch (error) {
			console.warn("Comic Downloader: could not read the log file", error);
		}
	}

	info(message: string, details?: unknown): void {
		this.add("INFO", message, details);
	}

	warn(message: string, details?: unknown): void {
		this.add("WARN", message, details);
	}

	error(message: string, details?: unknown): void {
		this.add("ERROR", message, details);
	}

	text(): string {
		return this.lines.join("\n");
	}

	async clear(): Promise<void> {
		this.lines = [];
		this.queueWrite((adapter) => adapter.write(this.path, ""));
		await this.writes;
	}

	private add(level: Level, message: string, details?: unknown): void {
		const consoleMethod = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
		if (details === undefined) consoleMethod(`Comic Downloader: ${message}`);
		else consoleMethod(`Comic Downloader: ${message}`, details);

		const text = details === undefined ? message : `${message}\n${describe(details)}`;
		const [first, ...rest] = text.split("\n");
		const prefix = `${moment().format("YYYY-MM-DD HH:mm:ss.SSS")} ${level.padEnd(5)}`;
		const lines = [`${prefix} ${first}`, ...rest.map((line) => `    ${line}`)];
		this.lines.push(...lines);
		if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
		this.queueWrite((adapter) => adapter.append(this.path, lines.join("\n") + "\n"));
	}

	/** Keeps file writes in order; a failed write never breaks the plugin. */
	private queueWrite(write: (adapter: DataAdapter) => Promise<void>): void {
		const adapter = this.adapter;
		if (!adapter) return;
		this.writes = this.writes
			.then(() => write(adapter))
			.catch((error) => console.warn("Comic Downloader: could not write the log file", error));
	}
}

function describe(details: unknown): string {
	if (details instanceof Error) {
		const status = (details as { status?: unknown }).status;
		const text = `${details.name}: ${details.message}${typeof status === "number" ? ` (HTTP ${status})` : ""}`;
		// Errors this plugin throws explain themselves; a stack trace only
		// helps with unexpected ones such as a TypeError.
		if (details.name === "Error" || !details.stack) return text;
		const frames = details.stack.split("\n").filter((line) => /^\s*at /.test(line));
		return [text, ...frames.slice(0, 6).map((frame) => frame.trim())].join("\n");
	}
	if (typeof details === "string") return details;
	let text: string;
	try {
		text = JSON.stringify(details, null, 2) ?? errorMessage(details);
	} catch {
		text = errorMessage(details);
	}
	return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export const log = new PluginLog();
