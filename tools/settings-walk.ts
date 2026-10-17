#!/usr/bin/env bun
/**
 * Walk every setting in the running TUI and report descriptions still in English.
 *
 * Why this exists: the settings panel paints only ONE item's description, in
 * the bottom area, and it changes as the cursor moves. Capturing a single frame
 * per tab therefore shows just the first item — a "0 English lines" result from
 * such a crawl is not evidence that a tab is translated. This walks the cursor
 * item by item across every tab and collects each distinct description.
 *
 * Uses `script(1)` for the pty, matching tools/scan-ui-english.ts, so it needs
 * no native dependency and works on Linux and macOS.
 *
 *   bun tools/settings-walk.ts                   # report only
 *   bun tools/settings-walk.ts --keep /tmp/walk  # also dump every frame
 *
 * Exit code 1 when any English description is found, so CI can gate on it.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);
const keepDir = argv.includes("--keep") ? argv[argv.indexOf("--keep") + 1] : undefined;
const maxItems = argv.includes("--max-items")
	? Number(argv[argv.indexOf("--max-items") + 1])
	: 45;
const tabs = argv.includes("--tabs") ? Number(argv[argv.indexOf("--tabs") + 1]) : 12;

/** Prose threshold: descriptions are sentences, labels are not. */
const PROSE_MIN_WORDS = 4;

/** Drop CSI / OSC / charset-switch escapes the TUI emits. */
const stripAnsi = (s: string): string =>
	s
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b[()][A-Z0-9]/g, "")
		.replace(/\x1b[=>]/g, "");

/** Panel body only: trim the box drawing and the status/footer chrome. */
const bodyLines = (frame: string): string[] =>
	stripAnsi(frame)
		.split("\n")
		.map(l => l.replace(/^[\s│]*/, "").replace(/[\s│]*$/, ""))
		.filter(l => l.length > 0);

/**
 * The description area sits between the item list and the preview block:
 *
 *     ...items...                              <- `label   value` rows
 *     Theme used when the terminal has a dark background
 *     Preview:
 *
 * Only that window is prose. Everything above is item labels (already
 * translated) and their values; everything below is the footer hint bar.
 */
const descriptionArea = (frame: string): string[] => {
	const lines = bodyLines(frame);
	const previewAt = lines.findIndex(l => /^Preview:$/.test(l));
	const body = previewAt >= 0 ? lines.slice(0, previewAt) : lines;
	// Walk up from the preview block: consecutive prose lines are the description;
	// the first line that looks like a `label   value` row ends it.
	const out: string[] = [];
	for (let i = body.length - 1; i >= 0; i--) {
		const line = body[i];
		if (!line) continue;
		const isRow = /\S\s{2,}\S/.test(line) && line.length < 90;
		if (isRow) break;
		out.unshift(line);
	}
	return out;
};

const isEnglishProse = (line: string): boolean => {
	if (/[\u4e00-\u9fff]/.test(line)) return false;
	if (line.length < 30) return false;
	const words = line.match(/[A-Za-z]{2,}/g) ?? [];
	if (words.length < PROSE_MIN_WORDS) return false;
	// Command lines and paths are not prose.
	if (/^[\s~$.]|\b(?:npm|bun|git|omp|curl)\b\s/.test(line)) return false;
	if (/[/\\]/.test(line) && !/\s{3,}/.test(line)) return false;
	return true;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const main = async (): Promise<number> => {
	if (keepDir) await fs.mkdir(keepDir, { recursive: true });

	const log = path.join(os.tmpdir(), `omp-settings-walk-${process.pid}.raw`);
	await fs.writeFile(log, "");

	const home = process.env.HOME ?? "";
	const cwd = path.join(home, ".omp-zh");
	const proc = spawn("script", ["-qec", "omp-zh --no-session", log], {
		cwd,
		env: { ...process.env, TERM: "xterm-256color", COLUMNS: "200", LINES: "60" },
		stdio: ["pipe", "ignore", "ignore"],
	});

	let consumed = 0;
	/** Full-screen text accumulated so far; wrapped lines stay in order. */
	let screen = "";

	const snapshot = async (): Promise<string> => {
		const raw = await fs.readFile(log, "utf8").catch(() => "");
		if (raw.length > consumed) {
			screen += stripAnsi(raw.slice(consumed));
			consumed = raw.length;
			// Keep the tail only; the panel never scrolls back further.
			if (screen.length > 200_000) screen = screen.slice(-100_000);
		}
		return screen;
	};

	const send = (keys: string) => proc.stdin.write(keys);

	await sleep(9000);
	send("/settings\r");
	await sleep(3500);

	const found = new Map<string, string>();

	for (let tab = 0; tab < tabs; tab++) {
		for (let i = 0; i < maxItems; i++) send("\x1b[A");
		await sleep(700);

		for (let item = 0; item < maxItems; item++) {
			const frame = await snapshot();
			if (keepDir) {
				await fs.writeFile(
					path.join(keepDir, `tab${tab}-${String(item).padStart(2, "0")}.txt`),
					frame,
				);
			}
			for (const line of descriptionArea(frame)) {
				if (!isEnglishProse(line)) continue;
				if (!found.has(line)) found.set(line, `tab${tab} item${item}`);
			}
			send("\x1b[B");
			await sleep(400);
		}
		send("\x1b[C");
		await sleep(1200);
	}

	proc.kill("SIGKILL");
	await fs.rm(log, { force: true });

	console.log(`english descriptions: ${found.size}`);
	for (const [line, where] of [...found].slice(0, 80)) {
		console.log(`  [${where}] ${line.slice(0, 160)}`);
	}
	return found.size > 0 ? 1 : 0;
};

process.exit(await main());
