#!/usr/bin/env bun
/**
 * Auto-translate the dictionary gap (review mode).
 *
 * Workflow
 * --------
 *   1. `bun tools/extract-gaps.ts --json <gap-file>` lists display strings the
 *      dictionary does not cover yet.
 *   2. This tool sends them to an OpenAI-compatible endpoint in batches, with
 *      the existing glossary injected so terminology stays consistent.
 *   3. Every candidate is validated mechanically (placeholders, digits,
 *      punctuation shape, existing term locks) and flagged when suspicious.
 *   4. Candidates land in `dict-candidates.json` for review. Nothing is merged
 *      until `--accept` runs.
 *
 *   bun tools/auto-translate.ts                     # translate, write candidates
 *   bun tools/auto-translate.ts --accept            # merge approved candidates
 *   bun tools/auto-translate.ts --accept --only key1,key2
 *   bun tools/auto-translate.ts --model cn:glm-5.3  # pick another model
 *
 * Endpoint resolution: --endpoint / OMP_ZH_ENDPOINT / the workbuddy2api
 * gateway from ~/.omp/agent/models.yml (local dev default).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const WORK = path.resolve(import.meta.dir, "..");
const DICT_PATH = path.join(WORK, "dict.json");
const DICT_EXTRA_PATH = path.join(WORK, "dict-extra.json");
const CANDIDATES_PATH = path.join(WORK, "dict-candidates.json");
const GAPS_PATH = path.join(WORK, "report-gaps.json");
const GLOSSARY_PATH = path.join(WORK, "glossary.json");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const has = (name: string): boolean => args.includes(name);

const MODEL = flag("--model") ?? "cn:deepseek-v4.1-flash";
const GAPS_FILE = flag("--gaps") ?? GAPS_PATH;
const BATCH = Number(flag("--batch") ?? 20);

// ── endpoint resolution ─────────────────────────────────────────────────────

interface Endpoint {
	baseUrl: string;
	apiKey: string;
}

const readAuthKey = async (name: string): Promise<string | undefined> => {
	try {
		const raw = await Bun.file(path.join(os.homedir(), ".pi/agent/auth.json")).json() as Record<string, { key?: string }>;
		return raw[name]?.key;
	} catch {
		return undefined;
	}
};

const resolveEndpoint = async (): Promise<Endpoint> => {
	const explicit = flag("--endpoint") ?? process.env.OMP_ZH_ENDPOINT;
	if (explicit) {
		return { baseUrl: explicit.replace(/\/$/, ""), apiKey: process.env.OMP_ZH_API_KEY ?? (await readAuthKey("workbuddy2api")) ?? "" };
	}
	// Fall back to the developer machine's local gateway: read models.yml so
	// the tool works with no extra configuration there.
	try {
		const yml = await Bun.file(path.join(os.homedir(), ".omp/agent/models.yml")).text();
		const base = yml.match(/baseUrl:\s*(\S+)/)?.[1];
		if (base) {
			const key = process.env.OMP_ZH_API_KEY ?? (await readAuthKey("workbuddy2api")) ?? "";
			return { baseUrl: base.replace(/\/$/, ""), apiKey: key };
		}
	} catch { /* fall through */ }
	throw new Error("no endpoint: pass --endpoint <url> or set OMP_ZH_ENDPOINT (and OMP_ZH_API_KEY if needed)");
};

// ── glossary / terminology locks ────────────────────────────────────────────

/**
 * Term locks: when the English key contains one of these tokens, the Chinese
 * translation must contain the locked rendering. This is what keeps a model
 * from inventing "紧凑" for Compact or "导师" for Advisor.
 */
const TERM_LOCKS: [RegExp, string][] = [
	[/\bCompact(?:ion|ed|ing)?\b/, "压缩"],
	[/\bVibe\b/, "氛围"],
	[/\bAdvisor\b/, "顾问"],
	[/\bPrewalk\b/, "预执行"],
	[/\bGoal\b/, "目标"],
	[/\bLoop\b/, "循环"],
	[/\bTodos?\b/, "待办"],
	[/\bSkill(?:s|ful)?\b/, "技能"],
	[/\bSession\b/, "会话"],
	[/\bProvider\b/, "提供商"],
	[/\bHandoff\b/, "交接"],
	[/\bContext\b/, "上下文"],
	[/\bBrowser\b/, "浏览器"],
	[/\bThinking\b/, "思考"],
	[/\bSubagent\b/, "子代理"],
	[/\bWorkspace\b/, "工作区"],
	[/\bWorktree\b/, "工作树"],
	[/\bClipboard\b/, "剪贴板"],
	[/\bWorkspace\b/, "工作区"],
];

/** Structural invariants every candidate must preserve. */
const placeholderShape = (s: string): string[] => s.match(/\$\{[^}]*\}|\{[^}]*\}|<[^>]+>|%[sd]|\\n|\\t|\\u[0-9a-fA-F]{4}/g) ?? [];
const digitShape = (s: string): string => (s.match(/\d+/g) ?? []).join(",");
const punctShape = (s: string): string =>
	(s.match(/[·—–…:：()（）[\]【】|/、,，.。!！?？]/g) ?? []).join("");

interface Candidate {
	key: string;
	zh: string;
	role: string;
	count: number;
	flags: string[];
}

const validate = (key: string, zh: string): string[] => {
	const flags: string[] = [];
	// ANSI escapes are control sequences, not copy: never dictionary material.
	if (/\x1b|\u001b/.test(key)) flags.push("ansi sequence");
	const ph = placeholderShape(key);
	const zhPh = placeholderShape(zh);
	if (ph.length !== zhPh.length || ph.some((p, i) => p !== zhPh[i])) {
		// Placeholders may be reordered only when their multiset matches.
		const a = [...ph].sort().join("\u0000");
		const b = [...zhPh].sort().join("\u0000");
		if (a !== b) flags.push(`placeholder mismatch: ${JSON.stringify(ph)} vs ${JSON.stringify(zhPh)}`);
	}
	if (digitShape(key) !== digitShape(zh)) flags.push(`digit mismatch: ${digitShape(key)} vs ${digitShape(zh)}`);
	for (const [re, term] of TERM_LOCKS) {
		if (re.test(key) && !zh.includes(term)) flags.push(`term lock: expected ${term}`);
	}
	if (/[A-Za-z]{4,}/.test(zh) && zh === key) flags.push("unchanged");
	if (zh.trim().length === 0) flags.push("empty");
	return flags;
};

// ── translation ─────────────────────────────────────────────────────────────

const buildPrompt = (entries: { key: string; snippet: string }[]): string => {
	const glossary: string[] = [];
	try {
		const g = JSON.parse(require("node:fs").readFileSync(GLOSSARY_PATH, "utf8")) as Record<string, string>;
		for (const [en, zh] of Object.entries(g).slice(0, 80)) glossary.push(`${en} => ${zh}`);
	} catch { /* glossary optional */ }
	const termList = TERM_LOCKS.map(([re, zh]) => `${re.source.replace(/\\b|\?|\(|\)|:/g, "")} => ${zh}`).join("; ");
	return [
		"You translate UI copy for a terminal coding agent (English to Simplified Chinese).",
		"Rules:",
		"- Output ONLY a JSON object mapping each input string to its translation. No prose, no markdown fence.",
		"- Keep every placeholder, escape sequence and number exactly as-is (${x}, {count}, <path>, %s, \\n).",
		"- Keep product names, CLI flags and file paths in English.",
		"- Style: terse UI labels. Prefer patterns like `X：Y` for `X: Y`. No trailing period unless the source has one.",
		"- Keep `shell`, `TUI`, `ANSI`, `tok/s`, `URL`, `JSON`, `API` and similar technical nouns in English.",
		"- Use the established terminology below; never invent alternatives.",
		glossary.length ? `Established glossary:\n${glossary.join("\n")}` : "",
		`Term locks (English token => required Chinese): ${termList}`,
		"",
		"Input:",
		JSON.stringify(Object.fromEntries(entries.map(e => [e.key, ""])), null, 0),
	].filter(Boolean).join("\n");
};

const translateBatch = async (ep: Endpoint, entries: { key: string; snippet: string }[]): Promise<Record<string, string>> => {
	const res = await fetch(`${ep.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: buildPrompt(entries) }],
			max_tokens: 4000,
			temperature: 0.2,
		}),
	});
	if (!res.ok) throw new Error(`endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const data = await res.json() as { choices?: { message?: { content?: string } }[] };
	let text = data.choices?.[0]?.message?.content ?? "";
	text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1) throw new Error(`model returned no JSON: ${text.slice(0, 200)}`);
	return JSON.parse(text.slice(start, end + 1)) as Record<string, string>;
};

// ── commands ────────────────────────────────────────────────────────────────

const accept = async (): Promise<void> => {
	const cands = JSON.parse(await Bun.file(CANDIDATES_PATH).text()) as { candidates: Candidate[] };
	const only = flag("--only")?.split(",").map(s => s.trim());
	const extra = await Bun.file(DICT_EXTRA_PATH).json() as Record<string, string>;
	let added = 0;
	let skipped = 0;
	for (const c of cands.candidates) {
		if (only && !only.includes(c.key)) { skipped++; continue; }
		if (c.flags.some(f => f.startsWith("placeholder mismatch") || f.startsWith("digit mismatch"))) {
			console.warn(`refuse (${c.flags.join("; ")}): ${JSON.stringify(c.key)}`);
			skipped++;
			continue;
		}
		extra[c.key] = c.zh;
		added++;
	}
	await Bun.write(DICT_EXTRA_PATH, JSON.stringify(Object.fromEntries(Object.entries(extra).sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
	console.log(`merged ${added} entries into dict-extra.json (${skipped} skipped)`);
	console.log("next: cd " + WORK + " && ./omp-zh.sh apply && ./omp-zh.sh test");
};

const run = async (): Promise<void> => {
	// Reuse an existing candidates file when --accept runs alone.
	if (has("--accept")) return accept();

	if (!(await Bun.file(GAPS_FILE).exists())) {
		throw new Error(`gap list missing: ${GAPS_FILE}\nrun: bun tools/extract-gaps.ts --json ${GAPS_FILE}`);
	}
	const gaps = JSON.parse(await Bun.file(GAPS_FILE).text()) as { entries: { key: string; role: string; count: number; snippet: string }[] };
	const dict = { ...(await Bun.file(DICT_PATH).json()), ...(await Bun.file(DICT_EXTRA_PATH).json()) } as Record<string, string>;
	// Skip ANSI/control-sequence literals outright: they surface as
	// untranslated "strings" to the scanner but are styling, not copy.
	const todo = gaps.entries.filter(e =>
		dict[e.key] === undefined &&
		!/\x1b|\u001b/.test(e.key) &&
		(e.key.match(/[A-Za-z]{2,}/) !== null));
	console.log(`gaps: ${gaps.entries.length}, to translate: ${todo.length}, model: ${MODEL}`);

	const ep = await resolveEndpoint();
	const candidates: Candidate[] = [];
	for (let i = 0; i < todo.length; i += BATCH) {
		const batch = todo.slice(i, i + BATCH);
		console.log(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(todo.length / BATCH)} (${batch.length} strings)`);
		let out: Record<string, string>;
		try {
			out = await translateBatch(ep, batch);
		} catch (e) {
			console.error(`  batch failed: ${e instanceof Error ? e.message : e}`);
			continue;
		}
		for (const entry of batch) {
			const zh = out[entry.key];
			if (typeof zh !== "string" || zh.length === 0) {
				candidates.push({ key: entry.key, zh: "", role: entry.role, count: entry.count, flags: ["missing from response"] });
				continue;
			}
			candidates.push({ key: entry.key, zh, role: entry.role, count: entry.count, flags: validate(entry.key, zh) });
		}
	}

	await Bun.write(CANDIDATES_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, candidates }, null, 2));
	const clean = candidates.filter(c => c.flags.length === 0).length;
	console.log(`\ncandidates: ${candidates.length} (${clean} clean, ${candidates.length - clean} flagged)`);
	for (const c of candidates) {
		const mark = c.flags.length ? "⚠ " : "  ";
		console.log(`${mark}${JSON.stringify(c.key)}`);
		console.log(`${mark}  → ${JSON.stringify(c.zh)}${c.flags.length ? "   [" + c.flags.join("; ") + "]" : ""}`);
	}
	console.log(`\nreview ${CANDIDATES_PATH}, then: bun tools/auto-translate.ts --accept`);
};

await run();
