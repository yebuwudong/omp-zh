/**
 * Scan the RUNNING app's UI surface for remaining English.
 * Renders the settings panel and welcome screen in a PTY, strips ANSI, and
 * reports English-looking lines so the gap list reflects what users actually
 * see rather than what the AST can guess.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

const CLI = "/home/yebu/.bun/bin/omp";
const OUT = "/tmp/omp-ui-scan.txt";

const run = async (): Promise<void> => {
	const proc = spawn("script", ["-qec", `${CLI} --no-session`, OUT], {
		cwd: "/tmp",
		env: { ...process.env, TERM: "xterm-256color" },
		stdio: ["pipe", "ignore", "ignore"],
	});
	// give the TUI time to paint the welcome screen, open settings, then quit
	const script: [number, string][] = [
		[7000, "/settings"],
		[1500, "\r"],
		[4000, "\x1b"],
		[1000, "\x03"],
		[1500, "\x03"],
	];
	for (const [delay, keys] of script) {
		await new Promise(r => setTimeout(r, delay));
		proc.stdin.write(keys);
	}
	await new Promise(r => setTimeout(r, 2500));
	proc.kill("SIGKILL");
};

await run();

const raw = await fs.readFile(OUT, "utf8").catch(() => "");
const text = raw
	.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
	.replace(/\x1b\][^\x07]*\x07/g, "")
	.replace(/\x1b[=>]/g, "");

const lines = text.split("\n").map(l => l.replace(/[│|]/g, " ").trim()).filter(Boolean);
const seen = new Set<string>();
const english: string[] = [];
for (const l of lines) {
	if (/[\u4e00-\u9fff]/.test(l)) continue;
	if (!/[A-Za-z]{3}/.test(l)) continue;
	if (/^(script|M:|COMMAND|EXIT)/.test(l)) continue;
	// collapse box-drawing noise and repeated layout rows
	const cleaned = l.replace(/\s{2,}/g, " ").trim();
	if (cleaned.length < 4) continue;
	if (seen.has(cleaned)) continue;
	seen.add(cleaned);
	english.push(cleaned);
}
console.log(`scanned lines: ${lines.length}, english-looking: ${english.length}`);
for (const l of english.slice(0, 80)) console.log("  " + l.slice(0, 118));
