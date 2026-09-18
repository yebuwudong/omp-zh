#!/usr/bin/env bun
/**
 * omp zh-CN patcher — translates display-only string literals inside the
 * bundled `dist/cli.js` of @oh-my-pi/pi-coding-agent (18.2.x).
 *
 * Model
 * -----
 * Every rewrite replaces one string literal with a call to an injected
 * runtime lookup: `"Dark Theme"` → `__omp_i18n_t("Dark Theme")`, where the
 * helper maps the original English text to its zh-CN translation (falling
 * back to the original when unknown). This keeps the English source as the
 * lookup key, mirrors the upstream `oh-my-pi-cn` design, and makes the patch
 * reversible at runtime (`OMP_ZH=0`) as well as on disk (`restore`).
 *
 * Safety
 * ------
 * Only literals in roles that cannot participate in identity/lookup logic
 * are rewritten:
 *   - propDisplay  value of a display-ish property (label, description, ...)
 *   - styleCall    argument of a theme style call (fg / bold / hint, ...)
 *   - classDisplay class property assigned a display key (label = "...")
 *   - assignDisplay x.label = "..."
 *   - arrayElem    element of a homogeneous string array (non-token)
 *   - other        plain literal position (phrase-like keys only)
 *
 * A key whose text occurs anywhere in a logic-family role (comparison, switch
 * case, computed member, regexp source, mutation calls, short-token arrays)
 * is downgraded to direct-display roles only, so identity flows (group names
 * checked with indexOf, enum tokens, protocol markers) can never be split
 * between English and Chinese.
 *
 * Commands
 * --------
 *   bun patch.ts report    dry-run: statistics, translate list, skip list
 *   bun patch.ts apply     backup + rewrite bundle in place
 *   bun patch.ts verify    re-parse patched bundle, assert rewrite invariants
 *   bun patch.ts restore   restore newest backup
 *   bun patch.ts path      print the resolved omp cli.js location
 */

import { parse } from "@babel/parser";
import * as crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { locateTemplates } from "./tools/patch-templates";

/**
 * Locate the installed omp bundle. Resolution order:
 *   1. `OMP_PKG` env override (points at the package root or cli.js)
 *   2. the `omp` launcher on PATH (symlink -> .../dist/cli.js)
 *   3. bun's global install directory
 * A missing bundle is a hard error only when a command actually touches it;
 * `path` still answers for scripts that need to know where omp lives.
 */
const resolveCliPath = (): string => {
	const candidates: string[] = [];
	const envPkg = process.env.OMP_PKG;
	if (envPkg) {
		candidates.push(envPkg.endsWith(".js") ? envPkg : path.join(envPkg, "dist", "cli.js"));
	}
	const fromPath = Bun.which("omp");
	if (fromPath) {
		try {
			candidates.push(realpathSync(fromPath));
		} catch {
			candidates.push(fromPath);
		}
	}
	candidates.push(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[candidates.length - 1];
};

const CLI_PATH = resolveCliPath();
const PKG = path.dirname(path.dirname(CLI_PATH));
const WORK = import.meta.dir;
const DICT_PATH = path.join(WORK, "dict.json");
const DICT_EXTRA_PATH = path.join(WORK, "dict-extra.json");
// Backups live next to the installed bundle, not inside the patch repo:
// multiple clones of this repo can manage the same omp install, and the
// pristine copy must stay reachable no matter which clone applied the patch.
// Earlier releases kept them under the repo (`<repo>/backup`); that location
// stays readable so existing installs keep working, and the first write
// migrates them next to the bundle.
const PRIMARY_BACKUP_DIR = process.env.OMP_ZH_BACKUP ?? path.join(path.dirname(CLI_PATH), ".omp-zh-backup");
const LEGACY_BACKUP_DIR = path.join(WORK, "backup");

/** Directories that may hold backups, primary first. */
const backupDirs = (): string[] => {
	const dirs = [PRIMARY_BACKUP_DIR];
	if (path.resolve(LEGACY_BACKUP_DIR) !== path.resolve(PRIMARY_BACKUP_DIR)) dirs.push(LEGACY_BACKUP_DIR);
	return dirs;
};

const listBackupEntries = async (): Promise<{ dir: string; name: string; mtimeMs: number }[]> => {
	const out: { dir: string; name: string; mtimeMs: number }[] = [];
	for (const dir of backupDirs()) {
		const entries = await fs.readdir(dir).catch(() => [] as string[]);
		for (const name of entries) {
			if (!name.startsWith("cli.js.orig-")) continue;
			const stat = await fs.stat(path.join(dir, name)).catch(() => null);
			if (stat) out.push({ dir, name, mtimeMs: stat.mtimeMs });
		}
	}
	return out;
};

/** Path of the pristine bundle, wherever it currently lives. */
const pristinePath = async (): Promise<string | null> => {
	for (const dir of backupDirs()) {
		const candidate = path.join(dir, "cli.js.orig-pristine");
		if (await Bun.file(candidate).exists()) return candidate;
	}
	return null;
};

/**
 * Copy every backup found in a legacy location into the primary
 * (bundle-adjacent) directory. Without this, a second clone of the repo sees
 * "汉化已应用" but has no pristine copy to restore from, and `apply` dies.
 * Runs before any command that reads backups.
 */
const migrateBackups = async (): Promise<void> => {
	const primary = path.resolve(PRIMARY_BACKUP_DIR);
	await fs.mkdir(primary, { recursive: true });
	for (const entry of await listBackupEntries()) {
		if (path.resolve(entry.dir) === primary) continue;
		const dest = path.join(primary, entry.name);
		if (await Bun.file(dest).exists()) continue;
		// Preserve mtime: restore ranks backups by it, and a fresh copyFile
		// timestamp would make an old bundle look like the newest one.
		await fs.copyFile(path.join(entry.dir, entry.name), dest);
		const srcStat = await fs.stat(path.join(entry.dir, entry.name));
		await fs.utimes(dest, srcStat.atime, srcStat.mtime);
	}
};

// Backups may live in either directory. Computed on demand in each command.
const BACKUP_DIR = PRIMARY_BACKUP_DIR;

const FN = "__omp_i18n_t";
const FN_BLOCK = "__omp_i18n_block";
const FN_FRAG = "__omp_i18n_f";
/** Builds a per-setting {raw value → display label} map from the setting def. */
const FN_VLM = "__omp_i18n_vlm";
/** Resolves the compact row's value cell: item map first, global table second. */
const FN_VR = "__omp_i18n_vr";
const DICT_VAR = "__omp_i18n_d";
const VAL_VAR = "__omp_i18n_vd";
const FRAG_VAR = "__omp_i18n_frag";
const FRAG_KEYS_VAR = "__omp_i18n_fragk";
const FLAG_VAR = "__omp_i18n_on";

// ── AST plumbing ────────────────────────────────────────────────────────────

interface AstNode {
	type: string;
	start?: number | null;
	end?: number | null;
	[key: string]: unknown;
}

const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

const childrenOf = (node: AstNode): AstNode[] => {
	const out: AstNode[] = [];
	for (const k of Object.keys(node)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range" || k === "leadingComments" || k === "trailingComments") continue;
		const v = node[k];
		if (Array.isArray(v)) {
			for (const c of v) if (isAstNode(c)) out.push(c);
		} else if (isAstNode(v)) out.push(v);
	}
	return out;
};

const nameOf = (node: AstNode | undefined): string =>
	node === undefined ? "" : String(node.name ?? "");

const propKeyOf = (node: AstNode): string => {
	const key = node.key as AstNode | undefined;
	if (!key) return "";
	if (key.type === "Identifier") return String(key.name ?? "");
	return key.type === "StringLiteral" ? String(key.value ?? "") : "";
};

const propNameOf = (member: AstNode | undefined): string => {
	if (!member || member.type !== "MemberExpression") return "";
	if (member.computed) return "";
	return nameOf(member.property as AstNode | undefined);
};

// ── role tables ─────────────────────────────────────────────────────────────

const CMP_OPS: Record<string, true> = {
	"==": true, "===": true, "!=": true, "!==": true, "<": true, ">": true, "<=": true, ">=": true,
};
const LOGIC_CALLS: Record<string, true> = {
	includes: true, startsWith: true, endsWith: true, indexOf: true, lastIndexOf: true, search: true,
	match: true, matchAll: true, test: true, exec: true, split: true, replace: true, replaceAll: true,
	localeCompare: true, charAt: true, slice: true, substring: true, equals: true, has: true, get: true,
	join: true, concat: true, filter: true, find: true, some: true, every: true, map: true, reduce: true,
};
const MUTATE_CALLS: Record<string, true> = {
	add: true, push: true, unshift: true, splice: true, set: true, insert: true, append: true, define: true,
};
/**
 * Theme/style helpers whose string arguments are rendered, verified against
 * the 18.2.x bundle: `fg`/`bold`/`dim`/`showStatus`/`showWarning`/... all
 * forward their text to the TUI. Minified names (`st`, `ts`, ...) are NOT
 * listed here even when they look display-ish — several of them are pure
 * data transforms (`e_`, `sZ`), so a name-based guess is unsafe at bundle
 * level. Unknown call sites fall through to `other`, which is only trusted
 * for phrase-like keys that appear exclusively outside logic roles.
 */
const STYLE_CALLS: Record<string, true> = {
	fg: true, bg: true, bold: true, dim: true, italic: true, underline: true, strikethrough: true,
	inverse: true, muted: true, accent: true, success: true, error: true, warning: true, info: true, hint: true,
	showStatus: true, showWarning: true, showError: true, showInfo: true, setStatus: true, output: true,
	notice: true, notify: true, toast: true, print: true, log: true, write: true, render: true,
	// `pe` is the bundle's visible-width helper; its argument is the very string
	// that gets rendered, so localizing it keeps the measurement correct.
	pe: true,
};
/** Calls that consume a string as data (lookup key, comparison basis, persisted value). */
const DATA_CALLS: Record<string, true> = {
	set: true, get: true, has: true, add: true, define: true, defineProperty: true, getOwnPropertyDescriptor: true,
	getModelRole: true, setSessionName: true, appendModeChange: true,
};
/**
 * Sibling property names that mark the enclosing object as model-facing
 * (tool definitions and their JSON-Schema parameters). Those descriptions are
 * part of the prompt, so translating them changes agent behavior — never touch
 * them, even when the text looks like ordinary copy.
 */
const MODEL_FACING_SIBLINGS: Record<string, true> = {
	parameters: true, inputSchema: true, loadMode: true, summary: true,
};
/** Sibling property names that mark the enclosing object as a UI descriptor. */
const UI_MARKERS: Record<string, true> = {
	tab: true, group: true, currentValue: true, value: true, values: true, options: true,
	category: true, icon: true, handle: true, handleTui: true, aliases: true, acpDescription: true,
};
const DISPLAY_KEYS: Record<string, true> = {
	label: true, description: true, title: true, displayName: true, placeholder: true, hint: true,
	subtitle: true, helpText: true, emptyText: true, tooltip: true, about: true, notice: true,
	caption: true, detail: true, warning: true, heading: true, message: true, text: true,
	selectorText: true, tips: true, footer: true, header: true,
};
const SCHEMA_KEYS: Record<string, true> = {
	inputSchema: true, parameters: true, properties: true, jsonSchema: true, argsSchema: true,
};
/**
 * Properties whose values are identities, lookups, or persisted configuration.
 * A key that ever appears in one of these positions is a data token, not copy,
 * so it is never translated — the same English string must keep matching
 * itself on both the producer and the consumer side.
 */
const DATA_PROPS: Record<string, true> = {
	default: true, values: true, name: true, id: true, key: true, type: true, kind: true,
	role: true, value: true, choices: true, enum: true, source: true, target: true, mode: true, op: true,
	tag: true, category: true, family: true, command: true, path: true, url: true, env: true, dir: true,
	file: true, action: true, selector: true, variant: true, icon: true, tab: true, scope: true,
};

/**
 * Text shapes that must not be rewritten: escapes, template placeholders,
 * printf specifiers, embedded code. Leading/trailing spaces are allowed —
 * several UI suffixes ("${sym} for commands") rely on them, and the lookup
 * preserves them verbatim.
 */
const RISKY_TEXT = /[\\\n\t\r]|\{\{|\}\}|\$\{|%\d|%s|:\/\/|[{}=;`]|^#|^--|^- /;

/**
 * JavaScript prototype property names. A plain `dict["__proto__"]` returns
 * `Object.prototype` instead of `undefined`, so the usual `!== undefined`
 * guard silently treats these as dictionary HITS. Wrapping them corrupts real
 * logic: upstream code writes `if (k === "__proto__") continue` to skip
 * prototype-polluting keys, and `k === __omp_i18n_t("__proto__")` compares
 * against `Object.prototype` instead — the guard becomes dead code. Never
 * translate these, whatever the dictionaries say.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
]);

/** Own-property-only lookup; never walks the prototype chain. */
const dictGet = (dict: Record<string, string>, key: string): string | undefined =>
	Object.hasOwn(dict, key) && !FORBIDDEN_KEYS.has(key) ? dict[key] : undefined;

/**
 * Strings verified by hand to be pure display despite living in structural
 * positions (help section headers built with `push("USAGE")`, the daemon
 * table header array whose members only feed width math and rendering).
 * Listing them here keeps the general rules strict — `push`, short-token
 * arrays, and mutation calls stay banned for everything else — while these
 * specific labels still get translated.
 */
const STRUCTURAL_UI_STRINGS: Record<string, true> = {
	// GitHub ops table (pso): op→title map whose values are rendered as the
	// tool-call title; keys stay English. Only member is `repo_view` (11 chars,
	// below the prose threshold) so it needs an explicit entry.
	"GitHub Repo": true,
	USAGE: true,
	COMMANDS: true,
	ARGUMENTS: true,
	FLAGS: true,
	EXAMPLES: true,
	// daemon table header (jJ) — members are rendered verbatim, never compared
	NAME: true,
	STATE: true,
	PID: true,
	UPTIME: true,
	RESTARTS: true,
	COMMAND: true,
};

/**
 * Roles that render straight to the screen and can be translated on their own,
 * even when the same English text also lives in a data slot elsewhere.
 */
const SPLIT_SAFE_ROLES: Record<string, true> = {
	propDisplay: true,
	classDisplay: true,
	styleCall: true,
	assignDisplay: true,
	groupKey: true,
	groupArrayElem: true,
};

/**
 * Keys whose display copies are translated while their data copies stay
 * English (`SPLIT_SAFE_ROLES` only). Each entry was hand-audited with
 * `bun patch.ts probe <key>`: the display occurrences are pure labels (settings
 * rows, tab bar, tool renderers, sidebar groups), and the remaining occurrences
 * are lookup keys, persisted names, or protocol identifiers that must not move
 * (shellcheck `language:"Shell"`, todo phase `name:"Todos"`, TMDB `P178`,
 * tool-class `label="Debug"`).
 *
 * Without this list the conservative rule applies: a single data/identity
 * occurrence skips the whole key to avoid splitting one value across two
 * languages.
 */
const SPLIT_UI_STRINGS: Record<string, true> = {
	// settings tabs (tab bar labels; also present as category-map returns,
	// shellcheck language ids and statusline constants — all kept English)
	Model: true,
	Context: true,
	Shell: true,
	Tools: true,
	Tasks: true,
	Providers: true,
	// settings sidebar groups (also todo phase names / TMDB property names)
	Composer: true,
	Thinking: true,
	Prewalk: true,
	Vision: true,

	Todos: true,
	Developer: true,
	// settings sidebar group (also `super("Theme")` border title, which the
	// anchor table rewrites separately)
	Theme: true,
	// tool rows in Settings → Tools and the matching tool-call renderers
	// (also tool-class `label=` display fields, which stay English)
	Debug: true,
	Ask: true,
	Security: true,
	"Speech Generation": true,
	"Web Search": true,
	"AST Grep": true,
	"AST Edit": true,
	// command list entry in --help (zwt={description}) vs the model-facing
	// class static description — only the help copy is translated.
	"Run the local CDP relay that lets the browser prelude drive your own Chrome tabs": true,
};

/**
 * Compact settings rows print the raw value (`true`, `auto`, `global`, ...)
 * taken straight from the schema, bypassing the dictionary. The reference
 * implementation maps those through `buildSettingValueLabels`, which sends
 * each value through `localizeUiText` — i.e. the same dictionary lookup used
 * for labels. Those keys are single lowercase tokens, which the scan must ban
 * as enum tokens (a `values:["auto",...]` array is a data slot), so the
 * mapping has to happen at the one render site instead of at each literal.
 *
 * Resolution is two-stage, mirroring the reference:
 *   1. per-item `valueLabels` built from the setting's own options
 *      (`__omp_i18n_vlm`, attached in `defToItem`) — this disambiguates
 *      collisions such as `none` meaning 关 / 无 / 隐藏 depending on the
 *      setting;
 *   2. this global table for everything without options: booleans and the
 *      option-less enums whose value cell cycles the raw token in place.
 * Keys below are the raw-value entries of the fork's settings table
 * (`zh-CN-settings.ts`, section "Raw enum/boolean values...") plus the
 * option-less enum tokens of v18. Anything else — paths, API keys, model ids,
 * free text — renders verbatim.
 */
const VALUE_LABELS: Record<string, string> = {
	true: "是",
	false: "否",
	auto: "自动",
	min: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最高",
	default: "默认",
	on: "开",
	off: "关",
	none: "无",
	global: "全局",
	"per-project": "按项目",
	inherit: "继承",
	flex: "灵活",
	priority: "优先",
	// Raw tokens of the option-less enums (v18 keeps them as `type:"enum"`
	// rows that cycle in place; their value cell has no option label to map
	// through, so they resolve here). Unambiguous across every setting.
	always: "始终",
	discard: "丢弃",
	keep: "保留",
	once: "一次",
	"after-gap": "间隔后",
	aggressive: "激进",
	session: "会话",
	"per-call": "每次调用",
};

/**
 * Surgical rewrites at sites the literal scan cannot reach: panel border
 * titles drawn verbatim (`oi(e,"Settings")`, `ev(e,"Agent Hub",o)`,
 * `super("Queue Mode")`) and the compact row's value cell.
 *
 * Each entry is located by an exact substring of the current bundle and must
 * match exactly once — `apply` refuses to run otherwise. Anchors are claimed
 * before the scan's rewrites; a scan op overlapping an anchor is dropped with
 * a warning, because the anchor text is stable upstream code while scan ops
 * are heuristic hits.
 *
 * Titles deliberately NOT listed here, with the reason:
 *   - `"Save and quit"` — the same constant (`kbo`) feeds the plan-review
 *     action list and is compared with `h===kbo`; wrapping the definition
 *     would break that identity check.
 *   - `super("Theme")` / `super("Thinking Level")` / `super("Session Tree")` —
 *     already translated by the literal scan (their literals are reachable
 *     through `propDisplay`/`other` roles).
 *   - Every remaining `fg(`/`bold(` header is prose-shaped and already
 *     covered (or skipped) by the scan.
 */
interface AnchorPatch {
	name: string;
	find: string;
	replace: string;
	/** Allow (and rewrite) more than one occurrence. Default: require exactly one. */
	all?: true;
	/**
	 * Minifier-proof fallback. The bundle is re-minified on every release and
	 * every internal identifier is renamed (`Ke` -> `$e`, `KJr` -> `qZr`), so
	 * an anchor written against one build stops matching the next. `loose`
	 * carries the same anchor text with the volatile identifiers written as
	 * their old spellings; at apply time each identifier-shaped token is
	 * compiled to a wildcard capture and the captured spelling is substituted
	 * into the loose replacement's `$name` placeholders. Literals,
	 * punctuation and property names are still matched verbatim, so the
	 * anchor stays precise while surviving renames.
	 */
	loose?: { find: string; replace: string };
}

const ANCHOR_PATCHES: readonly AnchorPatch[] = [
	// Help epilogue: environment-variable / tool / plugin / useful-command
	// reference block rendered by $3e (getExtraHelpText). Wrap the whole
	// template in the fragment translator so each row resolves through the
	// dictionary at runtime.
	{ name: "help epilogue block", find: "function $3e(){return`${H.bold(\"Environment Variables:\")}", replace: `function $3e(){return ${FN_FRAG}(\`\${H.bold("Environment Variables:")}` },
	{ name: "help epilogue close", find: "omp agents unpack --project - Export bundled subagents to ./.omp/agents`", replace: `omp agents unpack --project - Export bundled subagents to ./.omp/agents\`)` },
	// help examples: 9 template literals embedding the CLI binary via ${$e}.
	// Wrap each in the fragment translator so the comment lines resolve
	// through the dictionary (longest-match substitution).
	{ name: "help example: interactive mode", find: "`# Interactive mode\n  ${$e}`", replace: `${FN_FRAG}(\`# Interactive mode\n  \${$e}\`)` },
	{ name: "help example: interactive with prompt", find: '`# Interactive mode with initial prompt\n  ${$e} "List all .ts files in src/"`', replace: `${FN_FRAG}(\`# Interactive mode with initial prompt\n  \${$e} "List all .ts files in src/"\`)` },
	{ name: "help example: include files", find: '`# Include files in initial message\n  ${$e} @prompt.md @image.png "What color is the sky?"`', replace: `${FN_FRAG}(\`# Include files in initial message\n  \${$e} @prompt.md @image.png "What color is the sky?"\`)` },
	{ name: "help example: non-interactive", find: '`# Non-interactive mode (process and exit)\n  ${$e} -p "List all .ts files in src/"`', replace: `${FN_FRAG}(\`# Non-interactive mode (process and exit)\n  \${$e} -p "List all .ts files in src/"\`)` },
	{ name: "help example: continue", find: '`# Continue previous session\n  ${$e} --continue "What did we discuss?"`', replace: `${FN_FRAG}(\`# Continue previous session\n  \${$e} --continue "What did we discuss?"\`)` },
	{ name: "help example: shell shortcut", find: "`# Create a shell shortcut for a work profile\n  ${$e} --profile work --alias omp-work`", replace: `${FN_FRAG}(\`# Create a shell shortcut for a work profile\n  \${$e} --profile work --alias omp-work\`)` },
	{ name: "help example: fuzzy model", find: '`# Use different model (fuzzy matching)\n  ${$e} --model opus "Help me refactor this code"`', replace: `${FN_FRAG}(\`# Use different model (fuzzy matching)\n  \${$e} --model opus "Help me refactor this code"\`)` },
	{ name: "help example: limit models", find: "`# Limit model cycling to specific models\n  ${$e} --models claude-sonnet,claude-haiku,gpt-4o`", replace: `${FN_FRAG}(\`# Limit model cycling to specific models\n  \${$e} --models claude-sonnet,claude-haiku,gpt-4o\`)` },
	{ name: "help example: export html", find: "`# Export a session file to HTML\n  ${$e} --export ~/.omp/agent/sessions/--path--/session.jsonl`", replace: `${FN_FRAG}(\`# Export a session file to HTML\n  \${$e} --export ~/.omp/agent/sessions/--path--/session.jsonl\`)` },
	// CLI flag description composed via template interpolation (`--thinking`).
	{ name: "thinking flag description", find: "`Set thinking level: ${S5.join(\", \")}`", replace: `${FN_FRAG}(\`Set thinking level: \${S5.join(\", \")}\`)` },
	// Runtime error/support messages composed via template interpolation.
	{ name: "cli missing-arg error", find: "`Missing required argument: ${c}`", replace: `${FN_FRAG}(\`Missing required argument: \${c}\`)` },
				{ name: "usage no-credentials", find: "`No credentials found${u}. Run \\`omp\\` and use /login to add accounts.\n`", replace: `${FN_FRAG}(\`No credentials found\${u}. Run \\\`omp\\\` and use /login to add accounts.\n\`)` },
	{ name: "usage no-data", find: "`No usage data${u}. Stored credentials are for providers without a usage endpoint.\n`", replace: `${FN_FRAG}(\`No usage data\${u}. Stored credentials are for providers without a usage endpoint.\n\`)` },
	{ name: "plugin install hint", find: "`\nInstall plugins with: ${$e} plugin install <package>`", replace: `${FN_FRAG}(\`\nInstall plugins with: \${$e} plugin install <package>\`)` },
							{ name: "subcommand help hint", find: "`\nRun \\`${t} ${i.name} --help\\` for details.\n`", replace: `${FN_FRAG}(\`\nRun \\\`\${t} \${i.name} --help\\\` for details.\n\`)` },
		{ name: "subcommand usage header", find: "`USAGE\n  ${A0s(t,i.name,a)}\n`", replace: `${FN_BLOCK}(\`USAGE\n  \${A0s(t,i.name,a)}\n\`)` },
		// Autocomplete dropdown descriptions: run through the fragment translator so
		// dynamic labels like "Force: 12 active tools" resolve per-piece.
				// Slash-menu / status / update-notification dynamic copy: wrap each
		// template in the fragment translator and translate the fixed pieces.
		{ name: "force autocomplete desc", find: "t===0?\"Force: no active tools\":`Force: ${t} active tools`", replace: `t===0?${FN_FRAG}(\"Force: no active tools\"):${FN_FRAG}(\`Force: \${t} active tools\`)` },
		{ name: "green cmd desc", find: "description=\"Generate a prompt to iterate on CI failures until the branch is green\"", replace: `description=${FN}(\"Generate a prompt to iterate on CI failures until the branch is green\")` },
		{ name: "review cmd desc", find: "description=\"Launch interactive code review\"", replace: `description=${FN}(\"Launch interactive code review\")` },
		{ name: "init cmd desc", find: "description: Generate AGENTS.md for current codebase", replace: `description: ${FN}(\"Generate AGENTS.md for current codebase\")` },
		{ name: "update notification", find: "`New version ${e} is available. Run: `", replace: `${FN_FRAG}(\`New version \${e} is available. Run: \`)` },
		{ name: "tool output expansion status", find: "`Tool output expansion: ${this.ctx.toolOutputExpanded?\"enabled\":\"disabled\"}`", replace: `${FN_FRAG}(\`Tool output expansion: \${this.ctx.toolOutputExpanded?\"enabled\":\"disabled\"}\`)` },
				// Settings panel bottom hint bar: fragment-translate the concatenated
		// key hints ("Enter to change \u00b7 Tab to jump tabs \u00b7 ...").
				// Agent Hub section tabs.
						// Central status/warning sinks: every showStatus/showWarning call in the
		// bundle flows through these two renderers, so fragment-translating the
		// message at the sink covers all dynamic templates at once.
				// Agent Hub hint bars (three width-dependent variants).
		{ name: "agent hub hint narrow", find: "`${n}j/k:select  Enter:open  t:${s}  Tab:details  r/x:manage  Esc:close`", replace: `${FN_FRAG}(\`\${n}j/k:select  Enter:open  t:\${s}  Tab:details  r/x:manage  Esc:close\`)` },
		{ name: "agent hub hint detail", find: "`${n}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:${s}  Esc:roster`", replace: `${FN_FRAG}(\`\${n}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:\${s}  Esc:roster\`)` },
		{ name: "agent hub hint wide", find: "`${n}1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:${s}  r:revive  x:kill  Esc:close`", replace: `${FN_FRAG}(\`\${n}1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:\${s}  r:revive  x:kill  Esc:close\`)` },
		// Agent Hub roster hint (standalone panel).
		{ name: "agent hub roster hint", find: "cs(b.fg(\"dim\",\"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close\"),e)", replace: `cs(b.fg(\"dim\",${FN_FRAG}(\"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close\")),e)` },
		// showError root renderer: same sink approach as status/warning.
		{ name: "error sink", find: "showError(e){let t=new re(`Error: ${e}`,1,0)", replace: `showError(e){e=${FN_FRAG}(e);let t=new re(\`Error: \${e}\`,1,0)` },
{ name: "status sink", find: "showStatus(e,t){let s=this.ctx.chatContainer.children", replace: `showStatus(e,t){e=${FN_FRAG}(e);let s=this.ctx.chatContainer.children` },
		{ name: "warning sink", find: "showWarning(e,t){let s=new re(`Warning: ${e}`,1,0)", replace: `showWarning(e,t){e=${FN_FRAG}(e);let s=new re(\`Warning: \${e}\`,1,0)` },
{ name: "agent hub tabs", find: "`${e(\"agents\",\"1 Agents\")}${b.fg(\"dim\",b.sep.dot)}${e(\"activity\",\"2 Activity\")}`", replace: ` ${FN_FRAG}(\`\${e(\"agents\",\"1 Agents\")}\${b.fg(\"dim\",b.sep.dot)}\${e(\"activity\",\"2 Activity\")}\`)` },
{ name: "settings hint bar", find: "c.push(hs(b.fg(\"dim\",this.#y()),e))", replace: `c.push(hs(b.fg(\"dim\",${FN_FRAG}(this.#y())),e))` },
{ name: "tool activity hidden status", find: "`Tool activity is hidden \\u2014 show it with ${t} before expanding`", replace: `${FN_FRAG}(\`Tool activity is hidden \\u2014 show it with \${t} before expanding\`)` },
{ name: "autocomplete description resolver", find: "function KJr(e){if(\"getAutocompleteDescription\"in e&&typeof e.getAutocompleteDescription===\"function\")return e.getAutocompleteDescription()??e.description??\"\";return e.description??\"\"}", replace: `function KJr(e){var d;if(\"getAutocompleteDescription\"in e&&typeof e.getAutocompleteDescription===\"function\")d=e.getAutocompleteDescription()??e.description??\"\";else d=e.description??\"\";return ${FN_FRAG}(d)}` },
		// Keyboard Shortcuts panel: the markdown table is built by joining rows; wrap
		// the joined result in the fragment translator so each action phrase resolves.
				// Keyboard Shortcuts panel: the markdown table is built by joining rows; wrap
		// the joined result in the fragment translator so each action phrase resolves.
												// Keyboard Shortcuts panel: wrap the built markdown in the fragment translator
		// so each action phrase in the table resolves through the dictionary.
		{ name: "keyboard shortcuts panel", find: "M8(this.ctx,\"Keyboard Shortcuts\",e)", replace: `M8(this.ctx,${FN}(\"Keyboard Shortcuts\"),${FN_FRAG}(e))` },

	{ name: "settings panel title", find: 'oi(e,"Settings")', replace: `oi(e,${FN}("Settings"))` },
	{ name: "btw history title", find: 'oi(e,"BTW history")', replace: `oi(e,${FN}("BTW history"))` },
	// two render paths of the same panel share the literal
	{ name: "agent hub title", find: 'oi(e,"Agent Hub")', replace: `oi(e,${FN}("Agent Hub"))`, all: true },
	// composed headers: `Agent Hub · <id>` renders through the fragment
	// translator, which substitutes the `Agent Hub` piece inside the finished
	// string (full-string lookup can never match a dynamic suffix).
	{ name: "agent hub header (dot-id)", find: "`Agent Hub \\xB7 ${r.id}`", replace: `${FN_FRAG}(\`Agent Hub \\xB7 \${r.id}\`)` },
	{ name: "agent hub header (agentId)", find: "`Agent Hub ${b.sep.dot} ${this.deps.agentId}`", replace: `${FN_FRAG}(\`Agent Hub \${b.sep.dot} \${this.deps.agentId}\`)` },
	{ name: "recent logs title", find: 'oi(this.#l,"Recent Logs")', replace: `oi(this.#l,${FN}("Recent Logs"))` },
	{ name: "move-to-directory title", find: 'oi(t,"Move to directory")', replace: `oi(t,${FN}("Move to directory"))` },
	{ name: "raw provider stream title", find: 'oi(this.#u,"Raw Provider Stream")', replace: `oi(this.#u,${FN}("Raw Provider Stream"))` },
	{ name: "extension control center title", find: 'oi(e,"Extension Control Center")', replace: `oi(e,${FN}("Extension Control Center"))` },
	// Table headers drawn by `QM` (bordered table chrome).
	// Table/sidebar titles: upstream moved these from a helper call
	// (`ev(e,"Models",s)`) to a constructor argument
	// (`new UPe("Models",{min,max},...)`) and an inline width computation
	// (`GD(e,"Agent Hub",w)`); the wildcard matcher absorbs the rename, the
	// finds below track the call shape.
	{ name: "agent hub table title", find: 'GD(e,"Agent Hub",o.left?.width??0)', replace: `GD(e,${FN}("Agent Hub"),o.left?.width??0)` },
	{ name: "models table title", find: 'new UPe("Models",', replace: `new UPe(${FN}("Models"),` },
	{ name: "agents table title", find: 'new UPe("Agents",', replace: `new UPe(${FN}("Agents"),` },
	// Panel titles passed to `OverlayPanel` via `super(...)`.
	{ name: "queue mode title", find: 'super("Queue Mode")', replace: `super(${FN}("Queue Mode"))` },
	{ name: "show images title", find: 'super("Show Images")', replace: `super(${FN}("Show Images"))` },
	{ name: "debug tools title", find: 'super("Debug Tools")', replace: `super(${FN}("Debug Tools"))` },
	{ name: "history title", find: 'super("History")', replace: `super(${FN}("History"))` },
	{ name: "theme selector title", find: 'super("Theme")', replace: `super(${FN}("Theme"))` },
	{ name: "add mcp server title", find: 'super("Add MCP Server")', replace: `super(${FN}("Add MCP Server"))` },
	{ name: "spend rate-limit reset title", find: 'super("Spend a saved rate-limit reset")', replace: `super(${FN}("Spend a saved rate-limit reset"))` },
	// both plugin panels build their sidebar label the same way and share
	// the `super("Plugins")` border title
	{ name: "plugins tab label", find: "label:`${b.icon.package} Plugins`", replace: `label:\`\${b.icon.package} \${${FN}("Plugins")}\``, all: true },
	{ name: "plugins panel title", find: 'super("Plugins")', replace: `super(${FN}("Plugins"))`, all: true },
	// Providers settings page: a tab-bar section label, not the sidebar entry
	{ name: "providers section label", find: 'new $E("Providers",', replace: `new $E(${FN}("Providers"),` },
	// Compact settings row value cell: the raw value is printed as-is
	// (`true`/`false`/`auto`/`global`/...). Submenu rows (v18 routes every
	// enum/number/string setting that owns an option list here) get a
	// per-setting {raw value → display label} map attached in `defToItem`;
	// booleans and option-less enums fall back to the global table inside
	// `__omp_i18n_vr`, which is enough because their token sets are
	// unambiguous. Rows without a value set (text, provider limits,
	// multiselect) render verbatim.
	{
		name: "settings row value labels (submenu)",
		find: 'case"submenu":return{...s,currentValue:this.#P(e.path,t),submenu:',
		replace: `case"submenu":return{...s,currentValue:this.#P(e.path,t),valueLabels:${FN_VLM}(e.options),submenu:`,
	},
	{
		name: "settings row value cell",
		find: 'te(String(e.currentValue??""),f,os.Omit)',
		replace: `te(${FN_VR}(e),f,os.Omit)`,
	},
	// The search index feeds every keystroke through the row text; the
	// translated option labels must be searchable too, else typing 重建 stops
	// finding the Resize Scrollback row.
	{
		name: "settings row search index",
		find: 'if(e.values)t+=` ${e.values.join(" ")}`;return Opn(t)}',
		replace: `if(e.values)t+=\` \${e.values.join(" ")}\`;if(e.valueLabels)t+=\` \${Object.values(e.valueLabels).join(" ")}\`;return Opn(t)}`,
	},
];

// ── role classification ─────────────────────────────────────────────────────

type Role =
	| "objKey" | "importSrc" | "directive"
	| "logic" | "arrayTok" | "mutate" | "schema" | "dataValue"
	| "groupKey" | "groupArrayElem"
	| "propDisplay" | "styleCall" | "classDisplay" | "assignDisplay"
	| "arrayElem" | "other";

interface Occurrence {
	start: number;
	end: number;
	role: Role;
	via: string;
	snippet: string;
}

interface Classified {
	role: Role;
	via: string;
}

const classifyLiteral = (node: AstNode, parents: AstNode[]): Classified => {
	const parent = parents[parents.length - 1];
	const grand = parents[parents.length - 2];

	if (parent) {
		const isMemberish = parent.type === "ObjectProperty" || parent.type === "ObjectMethod" ||
			parent.type === "ObjectTypeProperty" || parent.type === "ClassProperty" ||
			parent.type === "ClassMethod" || parent.type === "PropertyDefinition";
		if (isMemberish && parent.key === node && !parent.computed) return { role: "objKey", via: parent.type };
		if ((parent.type.startsWith("Import") || parent.type.startsWith("Export")) && parent.source === node) {
			return { role: "importSrc", via: parent.type };
		}
		if (parent.type === "ExpressionStatement" && grand?.type === "Program") return { role: "directive", via: "program" };
		if (parent.type === "SwitchCase" && parent.test === node) return { role: "logic", via: "switch" };
		if (parent.type === "MemberExpression" && parent.computed && parent.property === node) return { role: "logic", via: "computedMember" };
		if (parent.type === "NewExpression" && nameOf(parent.callee as AstNode | undefined) === "RegExp") return { role: "logic", via: "regexp" };
		if (parent.type === "BinaryExpression" && typeof parent.operator === "string" && CMP_OPS[parent.operator] &&
			(parent.left === node || parent.right === node)) {
			return { role: "logic", via: "cmp:" + parent.operator };
		}
		if (parent.type === "CallExpression" && parent.callee) {
			const callee = parent.callee as AstNode;
			const calleeName = callee.type === "MemberExpression"
				? propNameOf(callee)
				: nameOf(callee);
			const isArg = Array.isArray(parent.arguments) && parent.arguments.includes(node);
			if (isArg && (LOGIC_CALLS[calleeName] || LOGIC_CALLS[nameOf(callee)])) return { role: "logic", via: "call:" + calleeName };
			if (isArg && (MUTATE_CALLS[calleeName] || MUTATE_CALLS[nameOf(callee)])) return { role: "mutate", via: "call:" + calleeName };
			if (isArg && DATA_CALLS[calleeName]) return { role: "dataValue", via: "call:" + calleeName };
			if (isArg && STYLE_CALLS[calleeName]) return { role: "styleCall", via: "style:" + calleeName };
		}
	}

	// schema subtree (model-facing tool docs) and describe() strings
	for (let i = parents.length - 1; i >= 0 && i >= parents.length - 9; i--) {
		const p = parents[i];
		if (!p) break;
		if (p.type === "ObjectProperty" && !p.computed && SCHEMA_KEYS[propKeyOf(p)]) return { role: "schema", via: "schema:" + propKeyOf(p) };
		if (p.type === "CallExpression" && Array.isArray(p.arguments) && p.arguments.includes(node)) {
			const c = p.callee as AstNode | undefined;
			if (c?.type === "MemberExpression" && propNameOf(c) === "describe") return { role: "schema", via: "describe" };
		}
	}

	// identity / persisted-configuration positions: never translate
	if (parent) {
		const isDataProp = (parent.type === "ObjectProperty" || parent.type === "ClassProperty" ||
			parent.type === "PropertyDefinition") && parent.value === node && !parent.computed &&
			DATA_PROPS[propKeyOf(parent)];
		if (isDataProp) return { role: "dataValue", via: "data:" + propKeyOf(parent) };
		// Array elements of an identity list (values:/choices:/enum:) are config tokens.
		if (parent.type === "ArrayExpression" && grand) {
			const isDataArray = (grand.type === "ObjectProperty" || grand.type === "ClassProperty") &&
				grand.value === parent && !grand.computed && DATA_PROPS[propKeyOf(grand)];
			if (isDataArray) return { role: "dataValue", via: "dataArray:" + propKeyOf(grand) };
		}
		if (parent.type === "VariableDeclarator" && parent.init === node) {
			const idName = nameOf(parent.id as AstNode | undefined);
			if (/^[A-Z][A-Z0-9_]*$/.test(idName)) return { role: "dataValue", via: "const:" + idName };
		}
	}

	if (parent) {
		const isValueProp = (parent.type === "ObjectProperty" || parent.type === "ClassProperty" ||
			parent.type === "PropertyDefinition") && parent.value === node && !parent.computed;
		if (isValueProp && DISPLAY_KEYS[propKeyOf(parent)]) {
			// Model-facing tool/parameter documentation must stay English: it is
			// prompt material, not UI copy. Skip it whenever the enclosing object
			// carries prompt-side siblings or sits directly in a JSON-Schema
			// properties block.
			const enclosing = parents[parents.length - 2];
			if (enclosing?.type === "ObjectExpression") {
				const siblings = (enclosing.properties as AstNode[]).filter(p => isAstNode(p) && p.type === "ObjectProperty");
				const names = siblings.map(propKeyOf);
				// CLI arg schemas (`ns.string({description, required, ...})` inside the
				// launchHelp args map) feed `--help`, not the model prompt: the enclosing
				// object is the argument of an `ns.*` call. Distinguish by shape —
				// grand is the `messages:` ObjectProperty whose value is the call.
				const nsCall = grand?.type === "ObjectProperty" &&
					(grand.value as AstNode | undefined)?.type === "CallExpression" &&
					((grand.value as AstNode).callee as AstNode | undefined)?.type === "MemberExpression" &&
					nameOf((((grand.value as AstNode).callee as AstNode).object) as AstNode | undefined) === "ns";
				if (!nsCall && names.some(n => MODEL_FACING_SIBLINGS[n])) return { role: "schema", via: "modelFacing" };
				if (grand?.type === "ObjectProperty" && propKeyOf(grand) === "properties") return { role: "schema", via: "jsonSchema" };
			}
			if (enclosing?.type === "ClassBody") return { role: "schema", via: "toolClass" };
			const role: Role = parent.type === "ObjectProperty" ? "propDisplay" : "classDisplay";
			return { role, via: (role === "propDisplay" ? "prop:" : "class:") + propKeyOf(parent) };
		}
		if (parent.type === "AssignmentExpression" && parent.right === node) {
			const left = parent.left as AstNode | undefined;
			if (left?.type === "MemberExpression" && !left.computed && DISPLAY_KEYS[propNameOf(left)]) {
				return { role: "assignDisplay", via: "assign:" + propNameOf(left) };
			}
		}
		if (parent.type === "ArrayExpression") {
			const elems = (parent.elements as (AstNode | null)[]).filter((e): e is AstNode => e !== null && isAstNode(e));
			if (elems.length >= 2 && elems.every(e => e.type === "StringLiteral")) {
				const shortTokens = elems.filter(e => typeof e.value === "string" &&
					(e.value as string).length <= 14 && !/\s/.test(e.value as string)).length;
				if (shortTokens / elems.length >= 0.7) return { role: "arrayTok", via: `arrayTok[${elems.length}]` };
				return { role: "arrayElem", via: `array[${elems.length}]` };
			}
			return { role: "arrayElem", via: `arrayMixed[${elems.length}]` };
		}
	}
	return { role: "other", via: parent?.type ?? "?" };
};

// ── scan ────────────────────────────────────────────────────────────────────

interface ScanOutcome {
	occurrences: Map<string, Occurrence[]>;
	totalLiterals: number;
	dictMatched: number;
}

/**
 * Structural discovery of the two places a settings section name can live:
 *   - `ui.group: "Display"` metadata inside the schema
 *   - the `TAB_GROUPS` object, keyed by tab id, holding arrays of group names
 * Both sides feed `order.indexOf(def.group)`, so they must always be
 * translated together (or not at all) to keep the index match intact.
 */
interface GroupSites {
	/** start offsets of string literals that are `group:` property values */
	propStarts: Set<number>;
	/** start offsets of string literals inside the TAB_GROUPS arrays */
	arrayStarts: Set<number>;
}

const findGroupSites = (ast: AstNode): GroupSites => {
	const propStarts = new Set<number>();
	const arrayStarts = new Set<number>();

	// TAB_GROUPS: an object whose properties are tab ids with string-array values.
	const isTabGroups = (node: AstNode): boolean => {
		if (node.type !== "ObjectExpression") return false;
		const props = (node.properties as AstNode[]).filter(p => isAstNode(p) && p.type === "ObjectProperty");
		if (props.length < 6) return false;
		let arraysOfStrings = 0;
		for (const p of props) {
			const v = p.value as AstNode | undefined;
			if (v?.type !== "ArrayExpression") continue;
			const elems = (v.elements as (AstNode | null)[]).filter((e): e is AstNode => !!e && isAstNode(e));
			if (elems.length >= 2 && elems.every(e => e.type === "StringLiteral")) arraysOfStrings++;
		}
		return arraysOfStrings >= 6;
	};

	const visit = (node: AstNode): void => {
		if (node.type === "ObjectProperty") {
			const key = propKeyOf(node);
			if (key === "group") {
				const v = node.value as AstNode | undefined;
				if (v?.type === "StringLiteral" && typeof v.start === "number") propStarts.add(v.start);
			}
		}
		const candidate = node.type === "ObjectProperty"
			? node.value as AstNode | undefined
			: node.type === "VariableDeclarator" || node.type === "AssignmentExpression"
				? (node.init ?? node.right) as AstNode | undefined
				: node.type === "CallExpression" && Array.isArray(node.arguments) && node.arguments.length === 1
					? node.arguments[0] as AstNode | undefined
					: undefined;
		if (candidate && isTabGroups(candidate)) {
			for (const p of (candidate.properties as AstNode[])) {
				if (!isAstNode(p) || p.type !== "ObjectProperty") continue;
				const arr = p.value as AstNode | undefined;
				if (arr?.type !== "ArrayExpression") continue;
				for (const e of (arr.elements as (AstNode | null)[])) {
					if (e && isAstNode(e) && e.type === "StringLiteral" && typeof e.start === "number") arrayStarts.add(e.start);
				}
			}
		}
		for (const child of childrenOf(node)) visit(child);
	};
	visit(ast);
	return { propStarts, arrayStarts };
};

const scanBundle = (code: string, dict: Record<string, string>): ScanOutcome => {
	const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
	const occurrences = new Map<string, Occurrence[]>();
	const groups = findGroupSites(ast);
	let totalLiterals = 0;
	let dictMatched = 0;

	const visit = (node: AstNode, parents: AstNode[]): void => {
		if (node.type === "StringLiteral" && typeof node.value === "string" && typeof node.start === "number") {
			totalLiterals++;
			const value = node.value;
			// RISKY_TEXT (mustache templates, code fragments, flag tokens) is now a
			// per-occurrence guard instead of a per-key scan filter: a key that merely
			// contains ';' or '=' but sits in a display-only position (CLI flag
			// descriptions) still translates, while logic positions stay blocked.
			if (dictGet(dict, value) !== undefined) {
				dictMatched++;
				const { role: baseRole, via: baseVia } = classifyLiteral(node, parents);
				const isGroupValue = groups.propStarts.has(node.start);
				const isGroupElem = groups.arrayStarts.has(node.start);
				const role: Role = isGroupValue ? "groupKey" : isGroupElem ? "groupArrayElem" : baseRole;
				const via = isGroupValue ? "group:prop" : isGroupElem ? "group:array" : baseVia;
				const from = Math.max(0, node.start - 90);
				const to = Math.min(code.length, (node.end ?? node.start) + 90);
				const occ: Occurrence = {
					start: node.start,
					end: node.end ?? node.start,
					role,
					via,
					snippet: code.slice(from, to).replace(/\n/g, "↵"),
				};
				const list = occurrences.get(value) ?? [];
				list.push(occ);
				occurrences.set(value, list);
			}
		}
		for (const child of childrenOf(node)) visit(child, [...parents, node]);
	};
	visit(ast, []);

	return { occurrences, totalLiterals, dictMatched };
};

// ── decision ────────────────────────────────────────────────────────────────

const DIRECT_ROLES: Record<string, true> = { propDisplay: true, styleCall: true, classDisplay: true, assignDisplay: true };
const TRANSLATABLE_ROLES: Record<string, true> = {
	...DIRECT_ROLES, arrayElem: true, other: true, groupKey: true, groupArrayElem: true,
};
/**
 * Roles that mark a string as an identity / protocol / logic token. A key
 * touching any of these is skipped wholesale: translating half of its
 * occurrences would split English and Chinese versions of the same value
 * across producers and consumers (group ordering, switch dispatch, enum
 * persistence, tool identity).
 */
const BANNING_ROLES: Record<string, true> = {
	logic: true, arrayTok: true, mutate: true, dataValue: true, objKey: true, schema: true,
};

interface KeyVerdict {
	key: string;
	zh: string;
	reason: string;
	translate: Occurrence[];
	skipped: Occurrence[];
}

const decideAll = (occurrences: Map<string, Occurrence[]>, dict: Record<string, string>): KeyVerdict[] => {
	const verdicts: KeyVerdict[] = [];
	for (const [key, occs] of occurrences) {
		const zh = dictGet(dict, key) ?? key;
		// Hand-verified display strings that structurally look like data tokens
		// (help headers, table headers) bypass the banning heuristics. Object
		// keys still stay untouched: those occurrences are the community dict's
		// own literal keys, and rewriting them would corrupt the table.
		if (Object.hasOwn(STRUCTURAL_UI_STRINGS, key) && !FORBIDDEN_KEYS.has(key)) {
			const translatable = occs.filter(o => o.role !== "objKey" && o.role !== "importSrc" && o.role !== "directive");
			verdicts.push({ key, zh, reason: "structural-ui:allowlisted", translate: translatable, skipped: occs.filter(o => !translatable.includes(o)) });
			continue;
		}
		// Hand-audited split: render-time copies are safe to translate, the
		// remaining occurrences are identity keys and must stay English. Only
		// the roles in SPLIT_SAFE_ROLES are rewritten, so a `{shell:{label:"Shell"}}`
		// key or a `language:"Shell"` id is never touched.
		if (Object.hasOwn(SPLIT_UI_STRINGS, key) && !FORBIDDEN_KEYS.has(key)) {
			const translatable = occs.filter(o => SPLIT_SAFE_ROLES[o.role]);
			if (translatable.length > 0) {
				verdicts.push({
					key, zh,
					reason: "split-ui:allowlisted",
					translate: translatable,
					skipped: occs.filter(o => !translatable.includes(o)),
				});
				continue;
			}
		}
		const ban = occs.find(o => BANNING_ROLES[o.role]);
		if (ban) {
			verdicts.push({ key, zh, reason: `banned:${ban.role}:${ban.via}`, translate: [], skipped: occs });
			continue;
		}
		const phrase = /\s/.test(key);
		// Risky-shaped keys (mustache {{}}, code fragments, embedded flags) may
		// still translate when every occurrence is a direct display position —
		// the guard moves from scan-time (per key) to decision-time (per role).
		const riskyText = RISKY_TEXT.test(key);
		const lowerToken = !phrase && key === key.toLowerCase() && /^[a-z][a-z0-9]*$/.test(key);
		if (lowerToken) {
			// A lowercase word is normally an enum token or path segment. It is safe
			// only when every occurrence is a rendered label (`{value:"auto",
			// label:"Auto"}` display side, or a style-call argument), never a bare
			// literal sitting in a data slot.
			const isLabelOnly = occs.every(o => o.role === "propDisplay" || o.role === "classDisplay" || o.role === "styleCall");
			if (!isLabelOnly) {
				verdicts.push({ key, zh, reason: "banned:lowercase-token", translate: [], skipped: occs });
				continue;
			}
			verdicts.push({ key, zh, reason: "lowercase-label", translate: occs, skipped: [] });
			continue;
		}
		// `other` occurrences are call sites whose callee is minified or unknown.
		// Only prose-shaped text is safe there: enum tokens, role tags, and path
		// segments are all short and space-free, so requiring whitespace or a
		// sentence-final punctuation keeps them out.
		//
		// `return "..."` is special: the value goes to the caller, and in this
		// bundle every short return-string that reaches the UI is a status
		// label (`return "Loop: off"` inside the autocomplete description).
		// Accept prose-shaped returns from 5 chars so `Loop: off` style labels
		// are not left behind; other call sites keep the stricter threshold.
		const PROSE = /[\s]|[.!?…。！？]$/;
		const proseish = PROSE.test(key);
		const disallowed: Occurrence[] = [];
		const accepted: Occurrence[] = [];
		for (const o of occs) {
			if (riskyText && !DIRECT_ROLES[o.role]) { disallowed.push(o); continue; }
			if (DIRECT_ROLES[o.role] || o.role === "groupKey" || o.role === "groupArrayElem") { accepted.push(o); continue; }
			if (o.role === "other" && proseish && (key.length >= 12 || o.via === "ReturnStatement")) { accepted.push(o); continue; }
			if (o.role === "arrayElem" && proseish) { accepted.push(o); continue; }
			disallowed.push(o);
		}
		if (disallowed.length > 0) {
			verdicts.push({
				key, zh,
				reason: `stray(${disallowed[0].role}:${disallowed[0].via})`,
				translate: [], skipped: occs,
			});
			continue;
		}
		verdicts.push({ key, zh, reason: phrase ? "phrase" : "single-word:direct", translate: accepted, skipped: [] });
	}
	return verdicts;
};

// ── template blocks (multiline UI corpora like tips.txt) ────────────────────

interface BlockRewrite {
	start: number;
	end: number;
	hits: number;
	lines: number;
	preview: string;
}

const findBlocks = (code: string, dict: Record<string, string>): BlockRewrite[] => {
	const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
	const blocks: BlockRewrite[] = [];
	const visit = (node: AstNode): void => {
		if (node.type === "TemplateLiteral" && typeof node.start === "number" && typeof node.end === "number") {
			const exprs = node.expressions as unknown[] | undefined;
			const quasis = node.quasis as AstNode[] | undefined;
			if (Array.isArray(exprs) && exprs.length === 0 && Array.isArray(quasis) && quasis.length === 1) {
				const raw = String((quasis[0].value as { raw?: unknown } | undefined)?.raw ?? "");
				// Cook the quasi text the way the runtime will see it after the
				// template evaluates (\uXXXX escapes and \` sequences), so hits
				// are counted against the same strings FN_BLOCK will look up.
				const cooked = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\`/g, "`");
				if (cooked.includes("\n") && !cooked.includes("{{")) {
					const lines = cooked.split("\n").map(l => l.trim()).filter(Boolean);
					const hits = lines.filter(l => dictGet(dict, l) !== undefined).length;
					// 2-line blocks are subcommand examples (`# comment` + command);
					// the comment line hits the dict and the command line stays verbatim.
					if (lines.length >= 2 && hits >= 1 && hits / lines.length >= 0.25) {
						blocks.push({
							start: node.start,
							end: node.end,
							hits,
							lines: lines.length,
							preview: cooked.slice(0, 100).replace(/\n/g, "\\n"),
						});
					}
				}
			}
		}
		for (const child of childrenOf(node)) visit(child);
	};
	visit(ast);
	return blocks;
};

// ── commands ────────────────────────────────────────────────────────────────

/**
 * The shipped translations come from two sources: `dict.json` (the community
 * oh-my-pi-cn table) and `dict-extra.json` (locally translated gaps for
 * upstream strings the community table never covered). Later files win on
 * conflict so a local override is always possible.
 */
const loadDict = async (): Promise<Record<string, string>> => {
	const base: Record<string, string> = await Bun.file(DICT_PATH).json();
	const merged: Record<string, string> = { ...base };
	if (await Bun.file(DICT_EXTRA_PATH).exists()) {
		const extra: Record<string, string> = await Bun.file(DICT_EXTRA_PATH).json();
		for (const [en, zh] of Object.entries(extra)) {
			if (zh === en) continue; // identity entries are "no translation decided"
			merged[en] = zh;
		}
	}
	return merged;
};

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** All start offsets of `needle` in `haystack` (non-overlapping scans). */
const findOccurrences = (haystack: string, needle: string): number[] => {
	const out: number[] = [];
	if (needle.length === 0) return out;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return out;
		out.push(idx);
		from = idx + needle.length;
	}
};

// ── minifier-proof anchors ──────────────────────────────────────────────────

import { matchLoose, renameTokens, describeRenames } from "./tools/loose-anchor";

/** Resolve one anchor to concrete spans: exact match first, wildcard second. */
const resolveAnchor = (
	code: string,
	patch: AnchorPatch,
): { start: number; end: number; replace: string; adapted: string }[] => {
	const exact = findOccurrences(code, patch.find);
	if (exact.length > 0) {
		return exact.map(start => ({ start, end: start + patch.find.length, replace: patch.replace, adapted: "" }));
	}
	const hits = matchLoose(code, patch.find);
	return hits.map(h => ({
		start: h.start,
		end: h.end,
		replace: renameTokens(patch.replace, h.renames),
		adapted: describeRenames(h.renames),
	}));
};

const report = async (): Promise<void> => {
	await migrateBackups();
	const dict = await loadDict();
	// Dry-run against the pristine bundle when the installed one is already
	// patched: on a patched file every wrapped call arg is a dict key again,
	// which double-classifies targets and buries the real verdicts.
	const pristine = await pristinePath();
	const installed = await Bun.file(CLI_PATH).text();
	const usePristine = installed.includes(`var ${DICT_VAR}=`) && pristine !== null;
	const code = await Bun.file(usePristine ? pristine as string : CLI_PATH).text();
	if (usePristine) console.log(`(installed bundle is patched — reporting on ${path.basename(pristine as string)})\n`);
	const { occurrences, totalLiterals, dictMatched } = scanBundle(code, dict);
	const verdicts = decideAll(occurrences, dict);
	const blocks = findBlocks(code, dict);

	const trans = verdicts.filter(v => v.translate.length > 0);
	const skipped = verdicts.filter(v => v.translate.length === 0);
	const transOcc = trans.reduce((a, v) => a + v.translate.length, 0);

	console.log(`bundle: ${(code.length / 1e6).toFixed(1)}MB, ${totalLiterals} string literals, ${dictMatched} dict-matched`);
	console.log(`keys: ${verdicts.length} | translate ${trans.length} keys / ${transOcc} occ | skip ${skipped.length} keys`);
	console.log(`template blocks: ${blocks.length}`);
	for (const b of blocks) console.log(`  [${b.hits}/${b.lines}] ${b.preview}`);

	const byReason = new Map<string, number>();
	for (const v of verdicts) {
		const cls = v.reason.split(/[(:]/)[0];
		byReason.set(cls, (byReason.get(cls) ?? 0) + 1);
	}
	console.log("\nkey classes:");
	for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${r}`);

	const roleCounts = new Map<string, number>();
	for (const v of trans) for (const o of v.translate) roleCounts.set(o.role, (roleCounts.get(o.role) ?? 0) + 1);
	console.log("\ntranslated occurrences by role:");
	for (const [r, n] of [...roleCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${r}`);

	const skipReasons = new Map<string, number>();
	for (const v of skipped) {
		const key = v.skipped.map(o => `${o.role}`).join(",") + (v.skipped.length === 0 ? "no-translatable" : "");
		skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
	}
	console.log("\nskipped-key reasons (roles present):");
	for (const [r, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(5)}  ${r}`);

	const lines: string[] = [];
	for (const v of trans.sort((a, b) => a.key.localeCompare(b.key))) {
		const roles = [...new Set(v.translate.map(o => o.role))].join("+");
		lines.push(`${JSON.stringify(v.key)}\t${JSON.stringify(v.zh)}\t${v.reason}\t${roles}\tx${v.translate.length}`);
	}
	await Bun.write(path.join(WORK, "report-translate.tsv"), lines.join("\n") + "\n");

	const detail: string[] = [];
	for (const v of trans) {
		detail.push(`\n===== ${JSON.stringify(v.key)} → ${JSON.stringify(v.zh)}  (${v.translate.length} occ, ${v.reason})`);
		for (const o of v.translate) detail.push(`  [${o.role}|${o.via}] …${o.snippet}…`);
	}
	await Bun.write(path.join(WORK, "report-translate-detail.txt"), detail.join("\n"));

	const skipDetail: string[] = [];
	for (const v of skipped) {
		skipDetail.push(`\n===== ${JSON.stringify(v.key)}  reason=${v.reason}  (${v.skipped.length} occ)`);
		const seen = new Set<string>();
		for (const o of v.skipped) {
			const sig = `${o.role}|${o.via}`;
			if (seen.has(sig)) continue;
			seen.add(sig);
			skipDetail.push(`  [${sig}] …${o.snippet}…`);
		}
	}
	await Bun.write(path.join(WORK, "report-skipped-detail.txt"), skipDetail.join("\n"));
	console.log(`\nwrote report-translate.tsv, report-translate-detail.txt, report-skipped-detail.txt`);
};

interface RewriteOp {
	start: number;
	end: number;
	key: string;
	zh: string;
	via: string;
}

const collectOps = (verdicts: KeyVerdict[], blocks: BlockRewrite[]): RewriteOp[] => {
	const ops: RewriteOp[] = [];
	for (const v of verdicts) {
		for (const o of v.translate) ops.push({ start: o.start, end: o.end, key: v.key, zh: v.zh, via: o.role + "|" + o.via });
	}
	for (const b of blocks) ops.push({ start: b.start, end: b.end, key: "<block>", zh: "<block>", via: `block[${b.hits}/${b.lines}]` });
	ops.sort((a, b) => a.start - b.start);
	for (let i = 1; i < ops.length; i++) {
		if (ops[i].start < ops[i - 1].end) {
			throw new Error(`overlapping rewrites at ${ops[i].start}: ${ops[i - 1].key} vs ${ops[i].key}`);
		}
	}
	return ops;
};

const apply = async (): Promise<void> => {
	await migrateBackups();
	const dict = await loadDict();
	const code = await Bun.file(CLI_PATH).text();
	if (code.includes(`var ${DICT_VAR}=`)) {
		throw new Error(
			`bundle already patched (found ${DICT_VAR}); run \`bun patch.ts restore\` first`,
		);
	}
	const { occurrences } = scanBundle(code, dict);
	const verdicts = decideAll(occurrences, dict);
	const blocks = findBlocks(code, dict);
	const ops = collectOps(verdicts, blocks);

	// Anchor rewrites target exact upstream spans the scan cannot reach
	// (panel titles passed verbatim to `oi`/`QM`/`super`, the compact row's
	// value cell). Each must match exactly once (or `all:true`) or apply
	// refuses, so a bundle change can never silently skip a site. When the
	// exact text is missing (a re-minified release renamed identifiers), the
	// wildcard matcher in tools/loose-anchor.ts captures the new spellings and
	// rewrites the replacement on the fly, so an upgrade no longer needs a
	// hand-edited anchor.
	const anchorOps: { start: number; end: number; wrap: null; kind: "anchor"; name: string; replace: string; adapted?: string }[] = [];
	const obsoleteAnchors: string[] = [];
	// Keys recovered from a broken anchor: upstream refactored the call shape
	// but the literal is still there in a display position the scan can see
	// (e.g. `ev(e,"Models",s)` -> `new UPe("Models",{...})`). Wrapping those
	// spans keeps the translation alive without a hand-edited anchor.
	const rescuedKeys = new Set<string>();
	const rescuedOps: { start: number; end: number; key: string }[] = [];
	const RESCUE_SAFE = (role: string): boolean =>
		DIRECT_ROLES[role] === true || role === "arrayElem" || role === "other" ||
		role === "groupKey" || role === "groupArrayElem";
	for (const patch of ANCHOR_PATCHES) {
		const hits = resolveAnchor(code, patch);
		if (hits.length === 0) {
			// The anchor span is gone. Upstream refactors sometimes replace a
			// call-site title with a display property the literal scan already
			// handles (`oi(this.#l,"Recent Logs")` -> `{title:"Recent Logs"}`).
			// That makes the anchor obsolete rather than broken: if every key
			// the replacement would have translated is already covered by the
			// scan, warn and carry on. Anything else is a real regression and
			// still fails the apply.
			const keys = [...patch.replace.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map(m => m[1]);
			const covered = keys.length > 0 && keys.every(k =>
				verdicts.some(v => v.key === k && v.translate.length > 0));
			if (covered) {
				console.warn(`anchor obsolete (key covered by scan): ${patch.name}`);
				obsoleteAnchors.push(patch.name);
				continue;
			}
			// Rescue: every key this anchor carried must appear in the bundle
			// with only display-safe roles. Then the scan positions carry the
			// translation and the anchor itself is obsolete.
			const keyOccs = keys.map(k => ({ key: k, occs: occurrences.get(k) ?? [] }));
			const rescuable = keyOccs.length > 0 &&
				keyOccs.every(({ occs }) => occs.length > 0 && occs.every(o => RESCUE_SAFE(o.role)));
			if (rescuable) {
				for (const { key, occs } of keyOccs) {
					if (rescuedKeys.has(key)) continue;
					rescuedKeys.add(key);
					for (const o of occs) rescuedOps.push({ start: o.start, end: o.end, key });
				}
				console.warn(`anchor rescued (key wrapped at scan position): ${patch.name}`);
				continue;
			}
			throw new Error(`anchor missing: ${patch.name} (${JSON.stringify(patch.find)})`);
		}
		if (hits.length > 1 && !patch.all) {
			throw new Error(`anchor not unique: ${patch.name} (${hits.length} matches for ${JSON.stringify(patch.find)})`);
		}
		for (const hit of hits) {
			if (hit.adapted) console.log(`anchor adapted: ${patch.name} (${hit.adapted})`);
			anchorOps.push({ start: hit.start, end: hit.end, wrap: null, kind: "anchor", name: patch.name, replace: hit.replace, adapted: hit.adapted || undefined });
		}
	}
	anchorOps.sort((a, b) => a.start - b.start);
	for (let i = 1; i < anchorOps.length; i++) {
		if (anchorOps[i].start < anchorOps[i - 1].end) {
			throw new Error(`anchors overlap: ${anchorOps[i - 1].name} vs ${anchorOps[i].name}`);
		}
	}
	console.log(`anchors: ${anchorOps.length} site(s) from ${ANCHOR_PATCHES.length} entries`);

	// Concatenated hints are invisible to the literal scan; wrap those templates
	// so the runtime fragment translator can finish the job.
	const { ops: tmplOps, missing: tmplMissing } = locateTemplates(code);
	for (const missing of tmplMissing) console.warn(`template target skipped: ${missing}`);

	// Overlaps are resolved by span size: the widest span wins and everything
	// nested inside it is dropped. A template wrapper therefore beats the
	// literal rewrites inside it — correct, because the wrapper translates the
	// finished string at runtime, fragments included, while a nested literal
	// call would only cover one piece of it. Anchors outrank both: they are
	// exact upstream spans, so a scan op colliding with one is the heuristic
	// hit and gets dropped.
	const allOps: { start: number; end: number; wrap: string | null; kind: "literal" | "template" | "anchor"; name?: string; replace?: string }[] = [
		...anchorOps,
		...ops.map(o => ({ start: o.start, end: o.end, wrap: (o.key === "<block>" ? FN_BLOCK : FN) as string | null, kind: "literal" as const })),
		...rescuedOps.map(o => ({ start: o.start, end: o.end, wrap: FN as string | null, kind: "literal" as const })),
		...tmplOps.map(o => ({ start: o.start, end: o.end, wrap: FN_FRAG as string | null, kind: "template" as const })),
	];
	allOps.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: typeof allOps = [];
	for (const op of allOps) {
		const clash = kept.find(k => op.start < k.end && k.start < op.end);
		if (clash) {
			if (op.kind === "anchor") {
				// should be impossible: anchors are checked for internal overlap below
				throw new Error(`anchor overlap: ${op.name} vs ${clash.kind} @${op.start}`);
			}
			if (clash.kind === "anchor") {
				console.warn(`overlap resolved: dropped ${op.kind} @${op.start}..${op.end} (anchor ${clash.name})`);
				continue;
			}
			// equal spans: the literal rewrite carries the exact translation
			if (op.start === clash.start && op.end === clash.end && op.kind === "literal") {
				kept.splice(kept.indexOf(clash), 1, op);
				continue;
			}
			const dropped = op.end - op.start <= clash.end - clash.start ? op : clash;
			if (dropped === clash) kept.splice(kept.indexOf(clash), 1);
			console.warn(`overlap resolved: dropped ${dropped.kind} @${dropped.start}..${dropped.end}`);
			if (dropped === op) continue;
		}
		kept.push(op);
	}
	kept.sort((a, b) => a.start - b.start);
	for (let i = 1; i < kept.length; i++) {
		if (kept[i].start < kept[i - 1].end) {
			throw new Error(`unresolved overlap at ${kept[i].start}: ${kept[i].kind} vs ${kept[i - 1].kind}`);
		}
	}

	const parts: string[] = [];
	let cursor = 0;
	for (const op of kept) {
		parts.push(code.slice(cursor, op.start));
		const src = code.slice(op.start, op.end);
		if (op.kind === "anchor") {
			parts.push(op.replace as string);
		} else if (op.wrap === null) {
			parts.push(src);
		} else {
			// Minified code glues keywords to literals (`return"Loop: off"`).
			// Inserting `__omp_i18n_t(` right after `return` would merge into the
			// single identifier `return__omp_i18n_t`, which parses fine but dies
			// at runtime. Separate them whenever the previous character can
			// continue an identifier.
			const prev = op.start > 0 ? code[op.start - 1] : "";
			const pad = /[A-Za-z0-9_$]/.test(prev) ? " " : "";
			parts.push(`${pad}${op.wrap}(${src})`);
		}
		cursor = op.end;
	}
	parts.push(code.slice(cursor));
	let out = parts.join("");

	// The runtime dictionary must cover every string the helper can ever be
	// asked about: the wrapped call sites AND the lines inside translated
	// template blocks (those never existed as standalone literals, so they
	// cannot be collected from the scan). Shipping the full table keeps both
	// paths correct; banned keys are inert because no call site references
	// them.
	const runtimeDict: Record<string, string> = { ...dict };
	// Fragment table: concatenated hints such as
	//   `Enter/Space to change · ${x}Type to search · Esc to close`
	// never exist as literals, so they are translated by substituting the static
	// pieces inside the finished string. Longest match wins (keys are sorted by
	// descending length) so a short key cannot damage a longer phrase.
	const runtimeFrags: Record<string, string> = {};
	for (const [en, zh] of Object.entries(dict)) {
		// Markdown bold headers (`**Navigation**`) have no whitespace but are
		// safe fragment keys; everything else keeps the whitespace rule so
		// single tokens can never collide inside dynamic text.
		if (FORBIDDEN_KEYS.has(en) || en.length < 6 || (!/\s/.test(en) && !/^\*\*.+\*\*$/.test(en)) || en.includes("{")) continue;
		runtimeFrags[en] = zh;
	}
	const fragKeys = Object.keys(runtimeFrags).sort((a, b) => b.length - a.length);
	const runtime =
		`var ${FLAG_VAR}=!(typeof process!=="undefined"&&process.env&&process.env.OMP_ZH==="0");\n` +
		`var ${DICT_VAR}=${JSON.stringify(runtimeDict)};\n` +
		`var ${VAL_VAR}=${JSON.stringify(VALUE_LABELS)};\n` +
		`var ${FRAG_VAR}=${JSON.stringify(runtimeFrags)};\n` +
		`var ${FRAG_KEYS_VAR}=${JSON.stringify(fragKeys)};\n` +
		// Object.hasOwn guards keep prototype names (`__proto__`, `constructor`)
		// from resolving through Object.prototype: without it a lookup of
		// `__proto__` returns a truthy object and the caller breaks.
		`function ${FN}(s){if(!${FLAG_VAR})return s;var r=Object.hasOwn(${DICT_VAR},s)?${DICT_VAR}[s]:void 0;return r===void 0?s:r;}\n` +
		`function ${FN_BLOCK}(s){if(!${FLAG_VAR})return s;return s.split("\\n").map(function(l){return ${FN}(l);}).join("\\n");}\n` +
		// Value cells: raw enum/boolean tokens only. Anything unknown (paths,
		// keys, model ids, free text) is returned unchanged, and a missing
		// table entry can never be mistaken for a translation because lookups
		// are own-property only.
		//
		// Two-stage resolution, mirroring the reference implementation's
		// `buildSettingValueLabels`:
		//   vlm(options) builds { rawValue → option.label } for one setting
		//   (labels run through the dictionary again, so unwrapped tokens like
		//   `Off` resolve). Items without options fall through to the global
		//   raw-token table, which is enough for booleans and option-less
		//   enums because their token sets are unambiguous.
		`function ${FN_VLM}(o){if(!${FLAG_VAR}||!Array.isArray(o))return;var m={},n=0;for(var i=0;i<o.length;i++){var p=o[i];if(!p||p.label==null)continue;var k=String(p.value);if(k==="__proto__"||k==="constructor"||k==="prototype")continue;var l=${FN}(p.label);if(l!==k){m[k]=l;n++;}}return n?m:void 0;}\n` +
		`function ${FN_VR}(e){var s=String(e.currentValue??"");if(!${FLAG_VAR})return s;var m=e.valueLabels,l=m&&Object.hasOwn(m,s)?m[s]:void 0;if(l!==void 0)return l;if(!e.values)return s;return Object.hasOwn(${VAL_VAR},s)?${VAL_VAR}[s]:s;}\n` +
		`function ${FN_FRAG}(s){if(!${FLAG_VAR})return s;var t=Object.hasOwn(${DICT_VAR},s)?${DICT_VAR}[s]:void 0;if(t!==void 0)return t;` +
		`for(var i=0;i<${FRAG_KEYS_VAR}.length;i++){var k=${FRAG_KEYS_VAR}[i];if(s.indexOf(k)===-1)continue;s=s.split(k).join(${FRAG_VAR}[k]);}` +
		`s=s.replace(/  +Search: /g,"  搜索：").replace(/  Type to search/g,"  输入以搜索");return s;}\n`;

	const anchor = out.startsWith("#!") ? out.indexOf("\n") + 1 : 0;
	out = out.slice(0, anchor) + runtime + out.slice(anchor);

	const verifyScan = scanBundle(out, dict);
	const residual = [...verifyScan.occurrences.values()].flat().filter(o => /[\u4e00-\u9fff]/.test(o.key)).length;
	console.log(`sanity: re-scan found ${residual} residual CJK-bearing keys in dict matches (expect 0)`);

	const codeHash = sha256(code);
	await fs.mkdir(BACKUP_DIR, { recursive: true });
	let backupPath: string | null = null;
	for (const entry of await listBackupEntries()) {
		const candidate = Bun.file(path.join(entry.dir, entry.name));
		if (await candidate.exists() && sha256(await candidate.text()) === codeHash) {
			backupPath = path.join(entry.dir, entry.name);
			break;
		}
	}
	if (backupPath === null) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		backupPath = path.join(BACKUP_DIR, `cli.js.orig-${stamp}`);
		await Bun.write(backupPath, code);
	}
	// Copy the mode from the installed file: a write+rename creates a fresh
	// inode, and the launcher symlink (`~/.bun/bin/omp` → dist/cli.js) only
	// works while the file stays executable.
	const installedMode = (await fs.stat(CLI_PATH)).mode & 0o777;
	const tmpPath = CLI_PATH + ".tmp-patch";
	await Bun.write(tmpPath, out);
	await fs.chmod(tmpPath, installedMode || 0o755);
	await fs.rename(tmpPath, CLI_PATH);

	const manifest = {
		appliedAt: new Date().toISOString(),
		bundleBefore: { size: code.length, sha256: sha256(code) },
		bundleAfter: { size: out.length, sha256: sha256(out) },
		keys: verdicts.filter(v => v.translate.length > 0).map(v => ({ key: v.key, zh: v.zh, occ: v.translate.length, reason: v.reason })),
		blocks: blocks.map(b => ({ start: b.start, end: b.end, hits: b.hits, lines: b.lines })),
		anchors: anchorOps.map(a => ({ name: a.name, start: a.start, len: a.end - a.start, adapted: a.adapted ?? null, replace: a.replace })),
		obsoleteAnchors,
		rescuedKeys: [...rescuedKeys],
		valueLabels: Object.keys(VALUE_LABELS).length,
		ops: ops.length,
		backup: backupPath,
	};
	await Bun.write(path.join(WORK, "manifest.json"), JSON.stringify(manifest, null, 2));

	console.log(`patched ${ops.length} literal sites + ${anchorOps.length} anchor sites (${manifest.keys.length} keys)`);
	console.log(`size ${(code.length / 1e6).toFixed(2)}MB → ${(out.length / 1e6).toFixed(2)}MB`);
	console.log(`backup → ${backupPath}`);
};

const verify = async (): Promise<void> => {
	const code = await Bun.file(CLI_PATH).text();
	const dict = await loadDict();
	const parseStart = performance.now();
	const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
	const parseErrors = (ast as unknown as { errors?: unknown[] }).errors?.length ?? 0;
	console.log(`parse: ${parseErrors === 0 ? "OK" : `ERRORS=${parseErrors}`} (${(performance.now() - parseStart).toFixed(0)}ms)`);

	// The injected prologue legitimately contains CJK inside its own dict literal;
	// everything else must appear only as an argument to the lookup helper.
	const prologueEnd = code.indexOf("\n// @bun");

	let callArgs = 0;
	let blockArgs = 0;
	let strayCjk = 0;
	let badCallArg = 0;
	const problems: string[] = [];

	const visit = (node: AstNode, parents: AstNode[]): void => {
		if (node.type === "CallExpression") {
			const callee = node.callee as AstNode | undefined;
			const args = (node.arguments ?? []) as AstNode[];
			const inPrologue = typeof node.start === "number" && node.start < prologueEnd;
			if (nameOf(callee) === FN && !inPrologue) {
				callArgs++;
				const arg = args[0];
				if (!arg || arg.type !== "StringLiteral" || typeof arg.value !== "string") {
					badCallArg++;
					problems.push(`non-literal arg to ${FN} @${node.start}`);
				} else if (FORBIDDEN_KEYS.has(String(arg.value))) {
					// Upstream writes `k === "__proto__"` to skip prototype-polluting
					// keys; wrapping it would compare against Object.prototype and
					// silently disable the guard.
					badCallArg++;
					problems.push(`FORBIDDEN key wrapped @${node.start}: ${String(arg.value)}`);
				} else if (dictGet(dict, String(arg.value)) === undefined) {
					badCallArg++;
					problems.push(`arg not in dict @${node.start}: ${String(arg.value).slice(0, 50)}`);
				}
			} else if (nameOf(callee) === FN_BLOCK && !inPrologue) {
				blockArgs++;
			}
		}
		if (node.type === "StringLiteral" && typeof node.value === "string") {
			// Judge by SOURCE text, not the decoded value: upstream ships CJK as
			// `\uXXXX` escapes (provider names, script ranges) and those must not be
			// mistaken for literals this patch introduced.
			const sourceText = typeof node.start === "number" && typeof node.end === "number"
				? code.slice(node.start, node.end)
				: "";
			const inPrologue = typeof node.start === "number" && node.start < prologueEnd;
			if (!inPrologue && /[\u4e00-\u9fff]/.test(sourceText)) {
				const parent = parents[parents.length - 1];
				const viaHelper = parent?.type === "CallExpression" &&
					(nameOf(parent.callee as AstNode | undefined) === FN || nameOf(parent.callee as AstNode | undefined) === FN_BLOCK);
				if (!viaHelper) {
					strayCjk++;
					if (problems.length < 30) {
						problems.push(`CJK outside helper @${node.start} (parent=${parent?.type}): ${sourceText.slice(0, 60)}`);
					}
				}
			}
		}
		for (const child of childrenOf(node)) visit(child, [...parents, node]);
	};

	visit(ast, []);

	// Identifier-glue detection: minified code writes `return"..."`, so a naive
	// insertion produced `return__omp_i18n_t(...)` — one long identifier that
	// parses cleanly and only explodes at runtime. No rewrite may extend the
	// helper name; scan every identifier for a prefixed/suffixed variant.
	let glued = 0;
	const known: Record<string, true> = {
		[FN]: true, [FN_BLOCK]: true, [FN_FRAG]: true, [FN_VLM]: true, [FN_VR]: true,
		[FLAG_VAR]: true, [DICT_VAR]: true, [FRAG_VAR]: true, [FRAG_KEYS_VAR]: true, [VAL_VAR]: true,
	};
	const checkGlue = (node: AstNode): void => {
		if (node.type === "Identifier" && typeof node.name === "string" && !known[node.name]) {
			if (node.name.includes(FN) || node.name.includes(FN_FRAG) || node.name.includes(FN_VLM) || node.name.includes(FN_VR) || node.name.includes(FLAG_VAR) || node.name.includes(DICT_VAR) || node.name.includes(VAL_VAR)) {
				glued++;
				if (problems.length < 30) problems.push(`glued identifier @${node.start}: ${node.name}`);
			}
		}
		for (const child of childrenOf(node)) checkGlue(child);
	};
	checkGlue(ast);

	// Anchor and value-table invariants: every anchor patch must have landed
	// verbatim, and the value helpers must exist when a call site references
	// them.
	let anchorsOk = 0;
	const anchorMisses: string[] = [];
	// Anchors may have been applied through the wildcard fallback, in which
	// case the on-disk replacement carries the freshly captured identifiers
	// rather than the literal template. The manifest records what was actually
	// written, so verify against that when it matches this bundle's shape.
	// Anchors listed as obsolete were absorbed by the literal scan (upstream
	// refactored the call site into a display property) and count as applied.
	let appliedAnchors: { name: string; replace: string }[] | null = null;
	let obsoleteAnchors: string[] = [];
	try {
		const manifest = await Bun.file(path.join(WORK, "manifest.json")).json() as { anchors?: { name?: string; replace?: string }[]; obsoleteAnchors?: string[] };
		if (Array.isArray(manifest.anchors) && manifest.anchors.every(a => typeof a.replace === "string")) {
			appliedAnchors = manifest.anchors.map(a => ({ name: a.name ?? "?", replace: a.replace as string }));
		}
		if (Array.isArray(manifest.obsoleteAnchors)) obsoleteAnchors = manifest.obsoleteAnchors;
	} catch { /* no manifest: fall back to the literal templates */ }
	for (const patch of ANCHOR_PATCHES) {
		if (obsoleteAnchors.includes(patch.name)) { anchorsOk++; continue; }
		const candidates = appliedAnchors?.filter(a => a.name === patch.name).map(a => a.replace) ?? [];
		const hit = code.includes(patch.replace) || candidates.some(c => c.length > 0 && code.includes(c));
		if (hit) anchorsOk++;
		else anchorMisses.push(patch.name);
	}
	for (const miss of anchorMisses) problems.push(`anchor not applied: ${miss}`);
	const valSites = findOccurrences(code, `${FN_VR}(`).filter(at => at > prologueEnd).length;
	const vlmSites = findOccurrences(code, `${FN_VLM}(`).filter(at => at > prologueEnd).length;
	const valDef = code.includes(`function ${FN_VR}(`) && code.includes(`function ${FN_VLM}(`);
	const valVar = code.includes(`var ${VAL_VAR}=`);

	console.log(`helper calls: ${callArgs} | block calls: ${blockArgs} | stray CJK literals: ${strayCjk} | bad args: ${badCallArg} | glued identifiers: ${glued}`);
	console.log(`anchors: ${anchorsOk}/${ANCHOR_PATCHES.length} applied | value sites: cell=${valSites}, labels=${vlmSites} | def: ${valDef}, table: ${valVar}`);
	console.log(`flag var present: ${code.includes(`var ${FLAG_VAR}=`)} | dict var present: ${code.includes(`var ${DICT_VAR}=`)}`);
	if ((valSites > 0 || vlmSites > 0) && !(valDef && valVar)) problems.push(`value helper used but not defined (def=${valDef}, table=${valVar})`);
	if (problems.length) {
		console.log(`\nPROBLEMS (${problems.length}):`);
		for (const p of problems.slice(0, 30)) console.log("  " + p);
		process.exitCode = 1;
	} else {
		console.log("all invariants hold");
	}
};

const restore = async (): Promise<void> => {
	await migrateBackups();
	const backups = await listBackupEntries();
	if (backups.length === 0) throw new Error(`no backups found in ${backupDirs().join(" or ")}`);
	// Guard against version regressions: a stale backup (e.g. 18.2.1 sitting
	// next to a freshly upgraded 18.2.4 install) must never be written back.
	// The package.json version is the source of truth; prefer the newest
	// backup that embeds it.
	const pkgVersion = await Bun.file(path.join(PKG, "package.json")).json()
		.then((p: { version?: string }) => p.version)
		.catch(() => undefined);
	const ranked = backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
	let chosen = ranked[0];
	if (pkgVersion) {
		for (const entry of ranked) {
			const head = await Bun.file(path.join(entry.dir, entry.name)).slice(0, 4_000_000).text();
			if (head.includes(`"${pkgVersion}"`)) { chosen = entry; break; }
		}
	}
	const newest = path.join(chosen.dir, chosen.name);
	const data = await Bun.file(newest).text();
	const mode = (await fs.stat(CLI_PATH).mode & 0o777) || 0o755;
	await Bun.write(CLI_PATH, data);
	await fs.chmod(CLI_PATH, mode);
	console.log(`restored ${(data.length / 1e6).toFixed(2)}MB from ${newest}`);
};

const listBackups = async (): Promise<void> => {
	const entries = await listBackupEntries();
	for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
		const s = await fs.stat(path.join(entry.dir, entry.name));
		console.log(`${entry.name}  ${(s.size / 1e6).toFixed(2)}MB  ${s.mtime.toISOString()}  ${entry.dir}`);
	}
};

/**
 * `probe <key> [...]` — dump every occurrence of a dictionary key in the
 * pristine bundle with its classified role, plus the verdict the planner
 * reaches for it. Used to hand-audit keys the banning rules flag, so a split
 * (translate the display copies, keep the identifier copies) can be introduced
 * with evidence instead of guesswork.
 */
const probe = async (keys: string[]): Promise<void> => {
	await migrateBackups();
	if (keys.length === 0) {
		console.error("usage: bun patch.ts probe <en-key> [more keys...]");
		process.exitCode = 1;
		return;
	}
	const dict = await loadDict();
	const pristine = await pristinePath();
	if (pristine === null) {
		console.error(`pristine backup missing in ${backupDirs().join(" or ")}`);
		process.exitCode = 1;
		return;
	}
	const code = await Bun.file(pristine).text();
	const { occurrences } = scanBundle(code, dict);
	const verdicts = decideAll(occurrences, dict);
	for (const key of keys) {
		console.log(`\n===== ${JSON.stringify(key)} =====`);
		const occs = occurrences.get(key);
		if (!occs || occs.length === 0) {
			console.log("  (no dictionary-matched occurrences in pristine)");
			continue;
		}
		const v = verdicts.find(x => x.key === key);
		console.log(`  verdict: ${v?.reason ?? "?"} | translate=${v?.translate.length ?? 0} skipped=${v?.skipped.length ?? 0}`);
		for (const o of occs) {
			const flag = BANNING_ROLES[o.role] ? "  [BANNING]" : DIRECT_ROLES[o.role] ? "  [direct]" : "";
			console.log(`  [${o.role}|${o.via}]${flag} @${o.start}`);
			console.log(`      ...${code.slice(Math.max(0, o.start - 80), o.end + 40).replace(/\n/g, "\\n")}...`);
		}
	}
};

const command = process.argv[2] ?? "report";
if (command === "path") {
	console.log(CLI_PATH);
} else if (command === "migrate") {
	const before = await listBackupEntries();
	await migrateBackups();
	const after = await listBackupEntries();
	const copied = after.length - before.length;
	console.log(`backups: ${after.length} in ${PRIMARY_BACKUP_DIR}${copied > 0 ? ` (+${copied} migrated)` : ""}`);
} else
if (command === "report") await report();
else if (command === "apply") await apply();
else if (command === "verify") await verify();
else if (command === "restore") await restore();
else if (command === "list") await listBackups();
else if (command === "probe") await probe(process.argv.slice(3));
else {
	console.error(`unknown command: ${command} (report|apply|verify|restore|list|probe|path)`);
	process.exit(1);
}
