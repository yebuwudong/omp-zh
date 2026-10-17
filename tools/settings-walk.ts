#!/usr/bin/env bun
/**
 * Walk every setting in the running TUI and report descriptions still in English.
 *
 * The settings panel paints exactly one item's description, below the item
 * list, and it changes as the cursor moves. A single frame per tab therefore
 * only shows the first item — "no English found" from such a crawl is not
 * evidence a tab is translated. This walks the cursor item by item across every
 * tab and collects each distinct description.
 *
 * Frames are read through a real VT screen model (tools/vt-screen.ts), not by
 * grepping the raw stream: raw output interleaves partial repaints, so slicing
 * it produces garbled lines and misses the description area entirely.
 *
 * Uses `script(1)` for the pty, matching tools/scan-ui-english.ts — no native
 * dependency, works on Linux and macOS.
 *
 *   bun tools/settings-walk.ts                    # report
 *   bun tools/settings-walk.ts --keep /tmp/walk   # also dump each frame
 *   bun tools/settings-walk.ts --tabs 12 --max-items 45
 *
 * Exit code 1 when any English description is found, so CI can gate on it.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Screen } from "./vt-screen";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
	argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const keepDir = flag("--keep");
const maxItems = Number(flag("--max-items") ?? 45);
const tabs = Number(flag("--tabs") ?? 12);

/** Prose threshold: descriptions are sentences; labels are a few words. */
const PROSE_MIN_WORDS = 4;

const isEnglishProse = (line: string): boolean => {
	const s = line.trim();
	if (s.length < 30) return false;
	if (/[\u4e00-\u9fff]/.test(s)) return false;
	const words = s.match(/[A-Za-z]{2,}/g) ?? [];
	if (words.length < PROSE_MIN_WORDS) return false;
	// `label   value` rows are list items, not descriptions.
	if (/\S\s{3,}\S/.test(s)) return false;
	// Commands, paths and URLs are not prose either.
	if (/^(?:\/|~|[a-z]+:\/\/)/.test(s)) return false;
	// The status line, footer hint bar and box-drawing rules are chrome.
	if (/[▶┃─━═│]{2,}/.test(s)) return false;
	if (/[π◒⑂]/.test(s)) return false;
	if (/^[\s\-─━═]+$/.test(s)) return false;
	return true;
};

/**
 * The description block sits between the item list and the preview strip:
 *
 *   ...  Label            value        <- item rows (already translated)
 *   Long prose sentence describing the item
 *   Preview:                          <- sentinel, or the footer hint bar
 */
const descriptionLines = (screen: Screen): string[] => {
	const lines = screen.text().split("\n");
	const end = lines.findIndex(l => /^\s*预览:?\s*$/.test(l) || /^\s*Preview:\s*$/.test(l));
	const body = end >= 0 ? lines.slice(0, end) : lines;
	const out: string[] = [];
	for (let i = body.length - 1; i >= 0; i--) {
		const line = body[i].replace(/^[\s│]+|[\s│]+$/g, "");
		if (!line) continue;
		if (/\S\s{3,}\S/.test(line)) break; // reached the item rows again
		out.unshift(line);
	}
	return out;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const main = async (): Promise<number> => {
	if (keepDir) await fs.mkdir(keepDir, { recursive: true });

	const log = path.join(os.tmpdir(), `omp-settings-walk-${process.pid}.raw`);
	await fs.writeFile(log, "");

	const home = process.env.HOME ?? "";
	const proc = spawn("script", ["-qec", "omp-zh --no-session", log], {
		cwd: path.join(home, ".omp-zh"),
		env: { ...process.env, TERM: "xterm-256color", COLUMNS: "200", LINES: "60" },
		stdio: ["pipe", "ignore", "ignore"],
	});

	const screen = new Screen(60, 200);
	let consumed = 0;

	const pump = async (ms: number): Promise<void> => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			await sleep(150);
			const raw = await fs.readFile(log, "utf8").catch(() => "");
			if (raw.length > consumed) {
				screen.write(raw.slice(consumed));
				consumed = raw.length;
			}
		}
	};

	const send = (keys: string) => proc.stdin.write(keys);

	await pump(9000);
	send("/settings\r");
	await pump(3500);

	const found = new Map<string, string>();

	for (let tab = 0; tab < tabs; tab++) {
		for (let i = 0; i < maxItems; i++) send("\x1b[A");
		await pump(700);

		for (let item = 0; item < maxItems; item++) {
			if (keepDir) {
				await fs.writeFile(
					path.join(keepDir, `tab${tab}-${String(item).padStart(2, "0")}.txt`),
					screen.text(),
				);
			}
			// Descriptions wrap: join the block into one paragraph before judging,
			// otherwise every wrapped line looks like a separate English string and
			// a fully translated long description reports as several misses.
			const para = descriptionLines(screen).join(" ").replace(/\s+/g, " ").trim();
			if (isEnglishProse(para) && !found.has(para)) {
				found.set(para, `tab${tab} item${item}`);
			}
			send("\x1b[B");
			await pump(380);
		}
		send("\x1b[C");
		await pump(1200);
	}

	proc.kill("SIGKILL");
	await fs.rm(log, { force: true });

	console.log(`english descriptions: ${found.size}`);
	for (const [line, where] of [...found].slice(0, 100)) {
		console.log(`  [${where}] ${line.slice(0, 160)}`);
	}
	return found.size > 0 ? 1 : 0;
};

process.exit(await main());
