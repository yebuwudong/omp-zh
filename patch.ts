#!/usr/bin/env bun
/**
 * omp zh-CN patcher — translates display-only string literals inside the
 * bundled `dist/cli.js` of @oh-my-pi/pi-coding-agent.
 *
 * Version-agnostic: upstream ships a new build every few days, so nothing here
 * may assume a particular version. Anchors declare their alternate upstream
 * spellings (`alts`) and fall back to identifier wildcards, so a release only
 * needs a code change when upstream alters wording or removes a UI surface.
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
import { linkLaunchers } from "./tools/launchers";

/**
 * Locate the installed omp bundle. omp ships in four shapes and only one of
 * them is patchable in place:
 *
 *   bun global / npm / nix   -> dist/cli.js (plain JS text)      [patchable]
 *   prebuilt binary          -> single-file executable            [not patchable]
 *   homebrew                 -> formula wrapping the npm package  [usually JS]
 *   source checkout          -> built cli.js                      [patchable]
 *
 * The prebuilt binary embeds bytecode, not source, so it cannot be rewritten.
 * For that case we materialise the *same version* from npm into a sidecar
 * directory and patch that, then emit an `omp-zh` launcher. Everything the
 * patcher does afterwards is identical.
 */

/** True when the file starts with a native executable magic number. */
const isNativeBinary = (bytes: Uint8Array): boolean => {
	const b = bytes;
	if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // ELF
	if (b.length >= 4 && b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) return true; // Mach-O LE
	if (b.length >= 4 && b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && b[3] === 0xcf) return true; // Mach-O BE
	if (b.length >= 4 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe) return true; // fat Mach-O
	if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true; // PE
	return false;
};

/** Read a file's header and decide whether it is a prebuilt binary. */
const looksLikeNativeBinary = async (p: string): Promise<boolean> => {
	try {
		const probe = new Uint8Array(await Bun.file(p).slice(0, 4).arrayBuffer());
		return isNativeBinary(probe);
	} catch {
		return false;
	}
};

const SIDECAR_ROOT = path.join(os.homedir(), ".omp-zh", "runtime");
const LAUNCHER_DIR = path.join(os.homedir(), ".omp-zh", "bin");

const IS_WINDOWS = process.platform === "win32";
const READ_ONLY = process.argv[2] === "doctor";
const launcherPath = path.join(LAUNCHER_DIR, IS_WINDOWS ? "omp-zh.cmd" : "omp-zh");
const sidecarCliPath = (version: string): string =>
	path.join(SIDECAR_ROOT, version, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");

/**
 * Windows installs of a CLI never put a bare `omp` on PATH: npm and bun both
 * emit wrapper scripts (`omp.cmd`, `omp.ps1`, `omp.bat`) that exec the real JS
 * entry point. `Bun.which("omp")` therefore returns the *shim*, and treating it
 * as the bundle makes Babel parse batch syntax and the backup `mkdir` fail with
 * ENOTDIR. Recognise those extensions and resolve through to the package.
 */
const SHIM_EXTENSIONS = [".cmd", ".bat", ".ps1", ".psm1"];

const isShellShim = (p: string): boolean =>
	SHIM_EXTENSIONS.includes(path.extname(p).toLowerCase());

/**
 * `chmod` is a no-op on Windows (and throws on some filesystems), while the
 * executable bit is what keeps the launcher runnable on POSIX. Swallow
 * failures everywhere: a lost mode bit is never worth aborting a patch for.
 */
const makeExecutable = async (p: string, mode = 0o755): Promise<void> => {
	if (IS_WINDOWS) return;
	await fs.chmod(p, mode).catch(() => { /* read-only FS or unsupported: ignore */ });
};

interface OmpTarget {
	/** Path to the patchable cli.js. */
	cliPath: string;
	/** "installed" | "sidecar" */
	kind: "installed" | "sidecar";
	/** Version string when known (e.g. "18.4.2"). */
	version?: string;
	/** Launcher path created for sidecar installs. */
	launcher?: string;
}

const packageRoot = (cli: string): string => path.dirname(path.dirname(cli));

/** Read the version a bundle reports, without executing it. */
const bundleVersion = async (cli: string): Promise<string | undefined> => {
	try {
		const head = await Bun.file(cli).slice(0, 4_000_000).text();
		return head.match(/"(\d+\.\d+\.\d+)"/)?.[1];
	} catch {
		return undefined;
	}
};

/** Ask the installed omp for its version (works for binaries too). */
const probeVersion = (exe: string): string | undefined => {
	try {
		const proc = Bun.spawnSync([exe, "--version"], { stdout: "pipe", stderr: "ignore" });
		const out = proc.stdout.toString().trim();
		return out.match(/(\d+\.\d+\.\d+)/)?.[1];
	} catch {
		return undefined;
	}
};

/**
 * Materialise `<version>` from npm into the sidecar directory and return its
 * cli.js path. Uses `bun add` so the dependency tree matches what the binary
 * was built from.
 */
const materializeSidecar = async (version: string): Promise<string> => {
	const dir = path.join(SIDECAR_ROOT, version);
	const cli = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
	if (existsSync(cli)) return cli;
	// Progress goes to stderr, never stdout: this runs while `resolveTarget`
	// computes CLI_PATH, and `patch.ts path` prints CLI_PATH on stdout for
	// callers that capture it verbatim. Anything written to stdout here ends up
	// glued onto that path, so `[[ -f "$CLI" ]]` in omp-zh.sh fails and the
	// patch silently never applies.
	console.error(`二进制安装无法就地打补丁，正在获取同版本 JS 包（${version}）到 ${dir} …`);
	await fs.mkdir(dir, { recursive: true });
	const pkgJson = path.join(dir, "package.json");
	if (!existsSync(pkgJson)) {
		await Bun.write(pkgJson, JSON.stringify({ name: `omp-zh-runtime-${version}`, private: true, type: "module" }, null, 2) + "\n");
	}
	const proc = Bun.spawnSync(["bun", "add", `@oh-my-pi/pi-coding-agent@${version}`], {
		cwd: dir,
		// `bun add` is noisy and must not reach stdout either.
		stdout: "ignore",
		stderr: "inherit",
	});
	if (proc.exitCode !== 0 || !existsSync(cli)) {
		throw new Error(`failed to fetch @oh-my-pi/pi-coding-agent@${version} into ${dir}`);
	}
	return cli;
};

/**
 * Absolute path to the bun that is running this patcher. The launcher must not
 * rely on `bun` being on PATH: `~/.bun/bin` is commonly exported only by
 * interactive shell config (and fish/bash differ), while `omp-zh` may be
 * invoked from scripts, editors or a bare `sh`. Falls back to the bare name so
 * a moved bun still works when PATH does provide one.
 */
const BUN_PATH = ((): string => {
	try {
		const exe = process.execPath;
		if (exe && existsSync(exe) && /(^|[/\\])bun(?:\.exe)?$/i.test(exe)) return exe;
	} catch { /* fall through */ }
	const which = Bun.which("bun");
	return which ?? "bun";
})();

/**
 * Standalone precompiled binary for a sidecar version, next to the JS bundle it
 * was built from.
 */
const nativeBinaryPath = (version: string): string =>
	path.join(SIDECAR_ROOT, version, "omp-zh-native");

/**
 * Precompile the patched sidecar into a standalone binary that carries Bun's
 * bytecode cache.
 *
 * The sidecar is a ~30 MB JavaScript bundle, so `bun cli.js` re-parses and
 * re-compiles it on every launch — ~1.2 s measured on this arm64 machine. A
 * standalone binary built with `--bytecode` embeds the compiled bytecode and
 * skips that work: ~0.3 s for the same bundle, i.e. 4x faster startup, at the
 * cost of ~5.5 s of build time and ~190 MB of disk per version.
 *
 * `--format=esm` is mandatory, not cosmetic. `--bytecode` defaults to CommonJS,
 * CJS has no top-level `await`, and the upstream bundle uses it in 162 places;
 * without the flag Bun aborts with a bare "Failed to generate bytecode" that
 * names neither the format nor the await.
 *
 * Best-effort by design: any failure leaves the JS path working, because a
 * slower Chinese UI beats no Chinese UI.
 */
const compileNative = async (cli: string, version: string): Promise<string | undefined> => {
	if (process.env.OMP_ZH_NO_NATIVE === "1") return undefined;
	// Windows CMD launchers use the JS runtime, so compiling here adds no benefit.
	if (IS_WINDOWS) {
		console.error("Windows 启动器使用 Bun 直接运行 JS，跳过可选字节码预编译。");
		return undefined;
	}
	const out = nativeBinaryPath(version);
	// cwd must be inside the sidecar so `bun build` resolves the package's own
	// dependencies (`@oh-my-pi/pi-natives/vcs` and friends); from an unrelated
	// directory the build dies with "Could not resolve".
	const cwd = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(cli)))));
	console.error(`正在预编译字节码二进制（约 5 秒）：${out} …`);
	const proc = Bun.spawnSync(
		["bun", "build", "--compile", "--bytecode", "--format=esm", cli, "--outfile", out],
		{ cwd, stdout: "ignore", stderr: "pipe" },
	);
	if (proc.exitCode !== 0 || !existsSync(out)) {
		const why = proc.stderr.toString().trim().split("\n").pop() ?? `exit ${proc.exitCode}`;
		console.error(`预编译失败，继续使用 JS 路径（启动稍慢）：${why}`);
		return undefined;
	}
	await makeExecutable(out);
	console.error(`已生成字节码二进制：${out}`);
	return out;
};

/**
 * Write the `omp-zh` launcher that runs the patched sidecar bundle.
 *
 * The launcher must NOT hard-code one versioned sidecar path. A prebuilt omp
 * binary is upgraded in place (the manager swaps `versions/<v>` and re-points
 * `bin/omp`), while the sidecar for the new version only appears when someone
 * runs `apply` again. Pinning the path therefore leaves `omp-zh` silently
 * running the previous release until the user notices — the exact "official
 * omp is 18.10.1 but omp-zh is still on 18.10.0" report. Resolve the version at
 * launch time instead: prefer the sidecar matching the installed omp, fall
 * back to the newest patched sidecar, and say so when neither is patched.
 */
const writeLauncher = async (cli: string): Promise<string> => {
	await fs.mkdir(LAUNCHER_DIR, { recursive: true });
	const launcher = launcherPath;
	if (IS_WINDOWS) {
		const linked = await linkLaunchers(launcher, cli, BUN_PATH, [LAUNCHER_DIR], true);
		if (!linked.length) throw new Error(`cannot create or refresh generated launcher: ${launcher}`);
		return launcher;
	}
	// The embedded script is POSIX sh and must stay portable: macOS ships BSD
	// userland, so `sort -V` and `sed` back-reference greediness both bite.
	// Version comparison goes through awk (POSIX) and extraction through
	// `grep -oE`, which take the first version token instead of trimming one.
	const body =
		`#!/bin/sh\n` +
		`# Generated by omp-zh. Runs the patched omp bundle.\n` +
		`# Uses an absolute bun path so the launcher works without ~/.bun/bin on PATH.\n` +
		`BUN=${JSON.stringify(BUN_PATH)}\n` +
		`[ -x "$BUN" ] || BUN=bun\n` +
		`\n` +
		`# Resolve the sidecar at launch: the official omp is upgraded in place,\n` +
		`# and a hard-coded path would keep running the previous release until\n` +
		`# someone re-ran \`apply\`. FALLBACK is the sidecar this launcher was\n` +
		`# generated for.\n` +
		`RUNTIME_ROOT=${JSON.stringify(SIDECAR_ROOT)}\n` +
		`FALLBACK=${JSON.stringify(cli)}\n` +
		`\n` +
		`# Version the installed official omp reports (binary or JS package).\n` +
		`WANT=""\n` +
		`for OMP_BIN in omp "$HOME/.local/bin/omp" "$HOME/bin/omp"; do\n` +
		`\tcommand -v "$OMP_BIN" >/dev/null 2>&1 || continue\n` +
		`\tWANT=$("$OMP_BIN" --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)\n` +
		`\t[ -n "$WANT" ] && break\n` +
		`done\n` +
		`\n` +
		`sidecar_js() { echo "$RUNTIME_ROOT/$1/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"; }\n` +
		`sidecar_native() { echo "$RUNTIME_ROOT/$1/omp-zh-native"; }\n` +
		`# A standalone binary embeds the bytecode, so it starts ~4x faster than\n` +
		`# handing the 30MB bundle to bun.\n` +
		`#\n` +
		`# Validity is checked by file shape, never by running it: actually invoking\n` +
		`# the binary to probe it costs ~0.19s, which would be paid on every single\n` +
		`# launch and eat most of the 0.35s→0.13s saving. A truncated or wrongly\n` +
		`# compiled file is caught by its ELF/PE magic plus the size floor instead.\n` +
		`native_ok() {\n` +
		`\t[ -f "$1" ] || return 1\n` +
		`\t[ -s "$1" ] || return 1\n` +
		`\t# Bytecode binaries are ~190MB; anything tiny is a stub or a failed build.\n` +
		`\t[ "$(wc -c <"$1" 2>/dev/null || echo 0)" -gt 1000000 ] || return 1\n` +
		`\t# ELF (\\177ELF) or PE (MZ) header, read as two leading bytes.\n` +
		`\t[ "$(dd if="$1" bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n')" = "7f45" ] && return 0\n` +
		`\t[ "$(dd if="$1" bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n')" = "4d5a" ] && return 0\n` +
		`\treturn 1\n` +
		`}\n` +
		`# Freshness guards the upgrade case: rewriting cli.js makes an older binary\n` +
		`# stale, and running it would show the previous release's UI.\n` +
		`native_fresh() {\n` +
		`\tN=$(sidecar_native "$1")\n` +
		`\tJ=$(sidecar_js "$1")\n` +
		`\tnative_ok "$N" || return 1\n` +
		`\t[ -f "$J" ] || return 0\n` +
		`\t[ "$N" -nt "$J" ]\n` +
		`}\n` +
		`is_patched() { [ -f "$1" ] && grep -q 'var __omp_i18n_d=' "$1" 2>/dev/null; }\n` +
		`# 1 when $1 is a newer dotted version than $2.\n` +
		`newer_than() {\n` +
		`\tawk -v a="$1" -v b="$2" 'BEGIN{split(a,x,".");split(b,y,".");\n` +
		`\t\tfor(i=1;i<=3;i++){if((x[i]+0)>(y[i]+0)){print 1;exit}\n` +
		`\t\t\tif((x[i]+0)<(y[i]+0)){print 0;exit}} print 0}'\n` +
		`}\n` +
		`\n` +
		`CLI=""\n` +
		`NATIVE=""\n` +
		`CHOSEN_VER=""\n` +
		`WANT_HAS_SIDECAR=""\n` +
		`if [ -n "$WANT" ]; then\n` +
		`\tCAND=$(sidecar_js "$WANT")\n` +
		`\t[ -f "$CAND" ] && WANT_HAS_SIDECAR=1\n` +
		`\tif native_fresh "$WANT"; then NATIVE=$(sidecar_native "$WANT"); fi\n` +
		`\tif [ -n "$NATIVE" ] || is_patched "$CAND"; then CLI="$CAND"; CHOSEN_VER="$WANT"; fi\n` +
		`fi\n` +
		`if [ -z "$CLI" ] && [ -z "$WANT_HAS_SIDECAR" ]; then\n` +
		`\t# No usable sidecar for the installed version: apply has not been re-run\n` +
		`\t# since the upgrade. Use the newest sidecar that actually carries the\n` +
		`\t# patch so the UI stays Chinese instead of dropping to English — and say\n` +
		`\t# so, because running an older release silently is how "官方 18.10.1、\n` +
		`\t# omp-zh 还停在 18.10.0" goes unnoticed.\n` +
		`\tBEST_VER=""\n` +
		`\tfor DIR in "$RUNTIME_ROOT"/*/; do\n` +
		`\t\t[ -d "$DIR" ] || continue\n` +
		`\t\tV=$(basename "$DIR")\n` +
		`\t\tif native_fresh "$V" || is_patched "$(sidecar_js "$V")"; then :; else continue; fi\n` +
		`\t\tif [ -z "$BEST_VER" ] || [ "$(newer_than "$V" "$BEST_VER")" = 1 ]; then\n` +
		`\t\t\tBEST_VER="$V"\n` +
		`\t\tfi\n` +
		`\tdone\n` +
		`\tif [ -n "$BEST_VER" ]; then\n` +
		`\t\tCLI=$(sidecar_js "$BEST_VER"); CHOSEN_VER="$BEST_VER"\n` +
		`\t\tif native_fresh "$BEST_VER"; then NATIVE=$(sidecar_native "$BEST_VER"); fi\n` +
		`\tfi\n` +
		`fi\n` +
		`[ -n "$CLI" ] || CLI="$FALLBACK"\n` +
		`\n` +
		`# Braces are required around any variable followed by a CJK glyph: bash\n` +
		`# reads the leading byte of a multibyte character as part of the name and\n` +
		`# silently truncates the value.\n` +
		`if [ -n "$WANT" ] && [ -z "$WANT_HAS_SIDECAR" ] && [ "$CHOSEN_VER" != "$WANT" ]; then\n` +
		`\tif [ -n "$CHOSEN_VER" ]; then\n` +
		`\t\techo "omp-zh: 官方 omp 已是 \${WANT}，当前运行的是 \${CHOSEN_VER} 的汉化运行时。" >&2\n` +
		`\telse\n` +
		`\t\techo "omp-zh: 官方 omp 已是 \${WANT}，但没有可用的汉化运行时。" >&2\n` +
		`\tfi\n` +
		`\techo "        请重跑：\${HOME}/.omp-zh/omp-zh.sh apply" >&2\n` +
		`fi\n` +
		`# Prefer the bytecode binary; fall back to bun reading the JS bundle.\n` +
		`if [ -n "$NATIVE" ]; then exec "$NATIVE" "$@"; fi\n` +
		`exec "$BUN" "$CLI" "$@"\n`;
	await Bun.write(launcher, body);
	await makeExecutable(launcher);
	return launcher;
};

/**
 * Make `omp-zh` reachable without the user editing shell config by hand.
 *
 * A binary install cannot be patched in place, so the Chinese UI lives behind
 * the `omp-zh` launcher — but the launcher directory is not on PATH by
 * default, and a user who runs plain `omp` sees English and concludes the
 * patch failed. Symlink the launcher into every standard user bin directory
 * that already exists or can be created, so whichever directory the user's
 * shell already exports picks it up.
 *
 * Refreshes generated Windows shims on re-apply; unrelated files and links
 * are preserved, and the user is told which launchers are usable.
 */
const USER_BIN_DIRS = IS_WINDOWS
	? [
		// %APPDATA%\npm is what npm puts on the user PATH on Windows, and it is
		// where a `omp-zh.cmd` shim is actually found. Symlinking does not work
		// there: creating links needs admin rights or Developer Mode, and .cmd
		// resolution goes through PATHEXT rather than the executable bit.
		path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm"),
		path.join(os.homedir(), ".omp-zh", "bin"),
	]
	: [
		path.join(os.homedir(), ".local", "bin"),
		path.join(os.homedir(), "bin"),
	];

const linkLauncherIntoPath = (launcher: string, cli: string): Promise<string[]> =>
	linkLaunchers(launcher, cli, BUN_PATH, USER_BIN_DIRS, IS_WINDOWS);

/**
 * Follow a Windows/npm wrapper script to the JS bundle it actually runs.
 *
 * The shim is a two-line batch or PowerShell file whose text embeds the entry
 * path (`...\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js`). Parsing that
 * text is more reliable than guessing a global root, because npm, bun, pnpm and
 * nvm each place the package somewhere different. Returns undefined when no
 * `dist/cli.js`-shaped path can be recovered, in which case callers fall back
 * to the conventional global locations.
 */
const cliFromShim = async (shim: string): Promise<string | undefined> => {
	const REL = ["@oh-my-pi", "pi-coding-agent", "dist", "cli.js"];
	// Both npm and bun place the wrapper beside the tree it execs:
	//   <prefix>\omp.cmd  +  <prefix>\node_modules\@oh-my-pi\...
	// This probe alone covers both, without depending on how the shim spells
	// its path. Windows wrappers also `cd` nowhere, so the sibling layout is
	// what the shim's own `%~dp0` resolves to anyway.
	const sibling = path.join(path.dirname(shim), "node_modules", ...REL);
	if (existsSync(sibling)) return sibling;
	try {
		const text = await Bun.file(shim).text();
		// Batch uses backslashes; PowerShell uses both. Normalise, then strip
		// variable references (`%dp0%`, `$PSScriptRoot`) so only literal text
		// remains to match against.
		const normalised = text
			.replace(/\\/g, "/")
			.replace(/%~?dp0%|\$PSScriptRoot|\$\{PSScriptRoot\}/gi, "")
			.replace(/%[^%\r\n]+%|\$[A-Za-z_][A-Za-z0-9_]*/g, "");
		const marker = "@oh-my-pi/pi-coding-agent/dist/cli.js";
		const pattern = new RegExp(`[^\\s"'\`;|()<>]*${marker.replace(/[/.]/g, "\\$&")}`, "g");
		for (const m of normalised.matchAll(pattern)) {
			const at = m[0].indexOf("@oh-my-pi/");
			const prefix = m[0].slice(0, at);
			// An absolute prefix (drive letter or POSIX root) is used verbatim;
			// anything else is relative to the shim.
			const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(prefix);
			const base = isAbs ? path.normalize(prefix) : path.join(path.dirname(shim), prefix);
			const candidate = path.join(base, ...REL);
			if (existsSync(candidate)) return candidate;
		}
	} catch { /* unreadable shim: the caller falls back to conventional roots */ }
	return undefined;
};

/** Candidate global package roots to probe when no shim reveals the path. */
const globalPackageRoots = (): string[] => {
	const roots: string[] = [];
	const pm = path.join(os.homedir(), ".bun", "install", "global", "node_modules");
	roots.push(path.join(pm, "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
	if (IS_WINDOWS) {
		const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		// npm global prefix on Windows is %APPDATA%\npm; nvm-windows and pnpm
		// keep their own trees, so probe the common ones rather than guessing.
		roots.push(path.join(appData, "npm", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
		roots.push(path.join(localAppData, "pnpm", "global", "5", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		roots.push(path.join(programFiles, "nodejs", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
	}
	return roots;
};

/** True when `dir` is already exported by the current PATH. */
const dirOnPath = (dir: string): boolean =>
	(process.env.PATH ?? "").split(path.delimiter).some(p => p !== "" && path.resolve(p) === path.resolve(dir));

/** Resolve a native install without materializing anything for read-only diagnostics. */
const resolveBinaryTarget = async (exe: string): Promise<OmpTarget> => {
	if (process.env.OMP_ZH_NO_SIDECAR === "1") {
		throw new Error(`omp at ${exe} is a native binary; set OMP_PKG to a JS package`);
	}
	const version = probeVersion(exe) ?? await bundleVersion(exe);
	if (!version) throw new Error(`cannot determine omp version from ${exe}`);
	if (READ_ONLY) return { cliPath: sidecarCliPath(version), kind: "sidecar", version, launcher: launcherPath };
	const cli = await materializeSidecar(version);
	const launcher = await writeLauncher(cli);
	const linked = await linkLauncherIntoPath(launcher, cli);
	console.error(`已生成启动器：${launcher}`);
	if (linked.length > 0) {
		console.error(`启动器可用：${linked.join("、")}`);
	} else if (IS_WINDOWS) {
		console.error(`未能写入 PATH 中的启动器；可直接运行：${launcher}`);
	} else {
		console.error(`未能自动加入 PATH，请手动执行：export PATH="${LAUNCHER_DIR}:$PATH"`);
	}
	return { cliPath: cli, kind: "sidecar", version, launcher };
};

/**
 * Resolve what to patch. Explicit OMP_PKG always wins; otherwise the `omp` on
 * PATH decides, and a native binary triggers the sidecar path. `OMP_ZH_NO_SIDECAR=1`
 * disables the sidecar fallback (CI uses it to keep runs hermetic).
 */
const resolveTarget = async (): Promise<OmpTarget> => {
	const envPkg = process.env.OMP_PKG;
	if (envPkg) {
		if (isShellShim(envPkg)) {
			// Users on Windows reach for `OMP_PKG=...\omp.cmd` because that is
			// the path they see on PATH; resolve through it the same way.
			const fromShim = await cliFromShim(envPkg);
			if (fromShim) return { cliPath: fromShim, kind: "installed", version: await bundleVersion(fromShim) };
			throw new Error(
				`OMP_PKG points at a shell shim (${envPkg}) and the bundle path could not be read from it.\n` +
				`  Point OMP_PKG at the package directory instead, e.g. OMP_PKG=<...>/node_modules/@oh-my-pi/pi-coding-agent`,
			);
		}
		// A prebuilt binary (the official Windows installer drops omp.exe into
		// %LOCALAPPDATA%\omp) cannot be patched in place, so it must take the
		// sidecar route — treating it as a package dir would produce the
		// meaningless `<...>\omp.exe\dist\cli.js`.
		if (await looksLikeNativeBinary(envPkg)) return resolveBinaryTarget(envPkg);
		const cli = envPkg.endsWith(".js") ? envPkg : path.join(envPkg, "dist", "cli.js");
		return { cliPath: cli, kind: "installed", version: await bundleVersion(cli) };
	}
	const fromPath = Bun.which("omp");
	const candidates: string[] = [];
	if (fromPath) {
		try { candidates.push(realpathSync(fromPath)); } catch { candidates.push(fromPath); }
	}
	candidates.push(...globalPackageRoots());

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		// A Windows/npm wrapper is not a bundle: resolve through it to the real
		// cli.js before anything tries to parse or back it up.
		if (isShellShim(candidate)) {
			const cli = await cliFromShim(candidate);
			if (cli) {
				return { cliPath: cli, kind: "installed", version: await bundleVersion(cli) };
			}
			// No recoverable path: keep looking rather than handing a .cmd file
			// to Babel (which fails with a syntax error that names the wrong
			// problem) or to the backup mkdir (which fails with ENOTDIR).
			continue;
		}
		if (await looksLikeNativeBinary(candidate)) return resolveBinaryTarget(candidate);
		return { cliPath: candidate, kind: "installed", version: await bundleVersion(candidate) };
	}
	return { cliPath: candidates[candidates.length - 1], kind: "installed" };
};

/**
 * Resolved at module scope because nearly every command needs it, but a
 * *failure* here must not take `doctor` down with it: diagnosing a broken or
 * unsupported install is exactly when resolution fails, and a stack trace tells
 * the user nothing. Fall back to a best-effort path and let `doctor` report.
 */
const TARGET: OmpTarget = await resolveTarget().catch((e: unknown) => {
	if (!READ_ONLY) throw e;
	const envPkg = process.env.OMP_PKG;
	// Never concatenate onto something that is not a package directory:
	// `omp.cmd/dist/cli.js` and `omp.exe/dist/cli.js` are not paths anyone can
	// act on. Report the conventional location instead and let `doctor` explain
	// the real problem.
	const usable = envPkg !== undefined && !isShellShim(envPkg) && !envPkg.match(/\.exe$/i);
	const fallback = usable
		? (envPkg!.endsWith(".js") ? envPkg! : path.join(envPkg!, "dist", "cli.js"))
		: globalPackageRoots()[0];
	console.error(`警告：无法确定 omp 目标（${e instanceof Error ? e.message : String(e)}）`);
	console.error(`      已回退到 ${fallback}，请运行 \`bun patch.ts doctor\` 查看完整诊断。`);
	return { cliPath: fallback, kind: "installed" as const };
});
const CLI_PATH = TARGET.cliPath;
const PKG = packageRoot(CLI_PATH);


/**
 * Read the bundle and fail with an actionable message when the target is not
 * a JavaScript text file. `Bun.file().text()` happily decodes a binary
 * launcher into replacement characters, and Babel then reports a syntax error
 * at line 1 column 0 with no hint about the real problem (seen in the wild on
 * macOS installs where `omp` resolved to a compiled binary).
 */
const readBundle = async (target: string): Promise<string> => {
	const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
	if (bytes.length === 0) throw new Error(`bundle is empty: ${target}`);
	const head = bytes.subarray(0, 512);
	const nulCount = head.filter(b => b === 0).length;
	const text = new TextDecoder().decode(bytes);
	const replacement = (text.slice(0, 1024).match(/\uFFFD/g) ?? []).length;
	if (nulCount > 0 || replacement > 4) {
		throw new Error(
			`not a JavaScript bundle: ${target}\n` +
			`  looks like a binary or compressed file (NUL bytes: ${nulCount}, invalid UTF-8 runs: ${replacement})\n` +
			`  this patcher rewrites dist/cli.js — the plain JS file shipped inside the package.\n` +
			`  If your omp is a compiled single-file binary, point the patcher at the package instead:\n` +
			`    OMP_PKG=/path/to/node_modules/@oh-my-pi/pi-coding-agent ./omp-zh.sh apply`,
		);
	}
	return text;
};
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
/**
 * Path of the pristine (unpatched) bundle, wherever it lives.
 *
 * The patcher writes timestamped snapshots (`cli.js.orig-<iso>`), and only an
 * older release ever wrote the fixed name `cli.js.orig-pristine`. Tools that
 * need English originals (`report`, `probe`) therefore used to fail on any
 * install created by the current patcher. Fall back to the newest timestamped
 * snapshot, which mirrors the currently installed version.
 */
/** Newest `cli.js.orig-*` snapshot inside `dir`, or null when there is none. */
const newestBackupIn = async (dir: string): Promise<string | null> => {
	let names: string[] = [];
	try {
		names = await Array.fromAsync(new Bun.Glob("cli.js.orig-*").scan({ cwd: dir }));
	} catch {
		return null;
	}
	let best: { path: string; mtime: number } | null = null;
	for (const name of names) {
		const full = path.join(dir, name);
		const stat = await Bun.file(full).stat().catch(() => null);
		if (!stat) continue;
		if (!best || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs };
	}
	return best?.path ?? null;
};

const pristinePath = async (): Promise<string | null> => {
	for (const dir of backupDirs()) {
		const candidate = path.join(dir, "cli.js.orig-pristine");
		if (await Bun.file(candidate).exists()) return candidate;
	}
	let best: { path: string; mtime: number } | null = null;
	for (const entry of await listBackupEntries()) {
		if (!best || entry.mtimeMs > best.mtime) best = { path: path.join(entry.dir, entry.name), mtime: entry.mtimeMs };
	}
	return best?.path ?? null;
};

/**
 * Newest unpatched snapshot sitting next to an explicitly named bundle.
 *
 * `check --code <path>` is used by CI against a freshly downloaded package, but
 * a maintainer may point it at an installed (already patched) file. Scanning
 * the patched text makes every anchor miss, which reads as a real regression.
 * Fall back to the sibling `.omp-zh-backup/` the patcher wrote, preferring the
 * newest snapshot so the report describes the current upstream version.
 */
const newestPristineBeside = (target: string): Promise<string | null> =>
	newestBackupIn(path.join(path.dirname(target), ".omp-zh-backup"));

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
 * upstream bundles: `fg`/`bold`/`dim`/`showStatus`/`showWarning`/... all
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

/**
 * Dictionary keys shorter than the fragment table's length floor that are
 * still safe to substitute inside a finished string. The floor exists so a
 * one- or two-letter token cannot rewrite unrelated text by accident; each
 * entry here is a label with a trailing separator, hand-verified to appear
 * only as that label.
 */
const FRAGMENT_SHORT_KEYS: Record<string, true> = {
	// Welcome-tip / ask-dialog prefix, wrapped by TEMPLATE_TARGETS so the
	// fragment translator sees the whole `Tip: <text>` line.
	"Tip: ": true,
};

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
	// ── v18.10 audit ────────────────────────────────────────────────────────
	// Short labels whose *only* non-display occurrences are render helpers
	// (`Eo`/`ih` build a tool-call head, `rn`/`Ko` build buttons, `O` wraps a
	// span, `le` wraps text) or an identity copy that must stay English
	// (a discriminator like `k==="File"`, a table-header array, an XML tag).
	// Each was audited with `bun patch.ts probe <key>`; the split keeps the
	// identity copy English and translates the rendered one, so no producer /
	// consumer pair can end up in two languages.
	//
	// Deliberately NOT listed, because the label itself is the compared value:
	//   Abort / Approve / Revise  select() returns the option *label*, and the
	//                             caller compares it to decide the outcome.
	//   Authorization             HTTP header name (protocol identifier).
	//   internal error            error-classification substring.
	Find: true,
	Wait: true,
	Config: true,
	"Edit…": true,
	"By parent": true,
	Diagnostics: true,
	File: true,
	" daybreak": true,
	"Cancel job": true,
	Command: true,
	Commit: true,
	Configure: true,
	"Copy answer": true,
	Earlier: true,
	"empty deletes": true,
	Filter: true,
	Flat: true,
	Fork: true,
	"IDA Pro": true,
	Keep: true,
	Kill: true,
	Message: true,
	Path: true,
	Quit: true,
	References: true,
	Refresh: true,
	Remove: true,
	Scope: true,
	"Sign in to your providers": true,
	Stage: true,
	Staged: true,
	Stop: true,
	"Submit Result": true,
	Symbols: true,
	Tiny: true,
	Toggle: true,
	"user turns": true,
	"omp predict": true,
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
	/**
	 * Alternate spellings of the same anchor for upstream *refactors* (as
	 * opposed to renames, which the wildcard fallback handles). When upstream
	 * stops emitting a literal and starts building the same UI text from
	 * runtime values, the old `find` no longer exists in any release and no
	 * amount of wildcarding recovers it. Each alternate is tried with the same
	 * exact-then-wildcard strategy; whichever matches wins. Keeping the old
	 * spelling as the primary keeps every already-supported release working.
	 */
	alts?: readonly { find: string; replace: string }[];
}

const ANCHOR_PATCHES: readonly AnchorPatch[] = [
	// First-run setup uses its own renderer rather than the standard TUI text helpers.
	{ name: "setup scene heading", find: 'o=[le([O(n,"strong")])];if(r)o.push(le([O(r,"muted")]));', replace: `o=[le([O(${FN_FRAG}(n),"strong")])];if(r)o.push(le([O(${FN_FRAG}(r),"muted")]));` },
	{ name: "setup sign-in subtitle", find: "`Sign in to one or more providers. Press ${wt(\"tui.select.cancel\")} when you're done.`", replace: ` ${FN}("Sign in to one or more providers. Press {{key}} when you're done.").replace("{{key}}",wt("tui.select.cancel"))` },
	{ name: "setup progress", find: '`Setup step ${this.#n+1} of ${this.scenes.length}`', replace: ` ${FN}("Setup step {{current}} of {{total}}").replace("{{current}}",String(this.#n+1)).replace("{{total}}",String(this.scenes.length))`, all: true },
	{ name: "setup saved heading", find: '`${E.status.success} Setup saved`', replace: `${FN_FRAG}(\`\${E.status.success} Setup saved\`)`, all: true },
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
	// v18.8 新增的 goal 模式示例。
	{ name: "help example: goal mode", find: '`# Start working on a goal immediately\n  ${$e} --goal "Investigate the importer"`', replace: `${FN_FRAG}(\`# Start working on a goal immediately\n  \${$e} --goal "Investigate the importer"\`)` },
	// CLI flag description composed via template interpolation (`--thinking`).
	{ name: "thinking flag description", find: "`Set thinking level: ${S5.join(\", \")}`", replace: `${FN_FRAG}(\`Set thinking level: \${S5.join(\", \")}\`)` },
	// Runtime error/support messages composed via template interpolation.
	{ name: "cli missing-arg error", find: "`Missing required argument: ${c}`", replace: `${FN_FRAG}(\`Missing required argument: \${c}\`)` },
	// v18.8: usage 报表消息从模板改为拼接（`${u}` 插值消失），按新拼写补 alts。
	{ name: "usage no-credentials", find: "`No credentials found${u}. Run \\`omp\\` and use /login to add accounts.\n`", replace: `${FN_FRAG}(\`No credentials found\${u}. Run \\\`omp\\\` and use /login to add accounts.\n\`)`,
	  alts: [{ find: "c=\"No credentials found. Run `omp` and use /login to add accounts.\\n\"", replace: "c=__omp_i18n_f(\"No credentials found. Run `omp` and use /login to add accounts.\\n\")" }] },
	{ name: "usage no-data", find: "`No usage data${u}. Stored credentials are for providers without a usage endpoint.\n`", replace: `${FN_FRAG}(\`No usage data\${u}. Stored credentials are for providers without a usage endpoint.\n\`)`,
	  alts: [{ find: "c=`No usage data. Stored credentials are for providers without a usage endpoint.\n`;", replace: `c=${FN_FRAG}(\`No usage data. Stored credentials are for providers without a usage endpoint.\n\`);` }] },
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
		{ name: "agent hub hint narrow",
		  find: "`${n}j/k:select  Enter:open  t:${s}  Tab:details  r/x:manage  Esc:close`",
		  replace: `${FN_FRAG}(\`\${n}j/k:select  Enter:open  t:\${s}  Tab:details  r/x:manage  Esc:close\`)`,
		  // 上游后来把快捷键提示改为动态渲染（`j/k:select` → ${keys(["j","k"])}:select），
		  // 字面量随之消失，只能按新形态另写一条。
		  alts: [
		    { find: "`${n}${zt([\"j\",\"k\"])}:select  ${we(\"enter\")}:open  ${we(\"t\")}:${s}  ${we(\"tab\")}:details  ${zt([\"r\",\"x\"])}:manage  ${we(\"escape\")}:close`",
		      replace: `${FN_FRAG}(\`\${n}\${zt(["j","k"])}:select  \${we("enter")}:open  \${we("t")}:\${s}  \${we("tab")}:details  \${zt(["r","x"])}:manage  \${we("escape")}:close\`)` },
		  ] },
		{ name: "agent hub hint detail",
		  find: "`${n}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:${s}  Esc:roster`",
		  replace: `${FN_FRAG}(\`\${n}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:\${s}  Esc:roster\`)`,
		  // 上游后来把快捷键提示改为动态渲染（`j/k:select` → ${keys(["j","k"])}:select），
		  // 字面量随之消失，只能按新形态另写一条。
		  alts: [
		    { find: "`${n}1:agents  2:activity  ${we(\"tab\")}:roster  ${zt([\"pageUp\",\"pageDown\"])}:scroll  ${we(\"enter\")}:open  ${we(\"t\")}:${s}  ${we(\"escape\")}:roster`",
		      replace: `${FN_FRAG}(\`\${n}1:agents  2:activity  \${we("tab")}:roster  \${zt(["pageUp","pageDown"])}:scroll  \${we("enter")}:open  \${we("t")}:\${s}  \${we("escape")}:roster\`)` },
		  ] },
		{ name: "agent hub hint wide",
		  find: "`${n}1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:${s}  r:revive  x:kill  Esc:close`",
		  replace: `${FN_FRAG}(\`\${n}1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:\${s}  r:revive  x:kill  Esc:close\`)`,
		  // 上游后来把快捷键提示改为动态渲染（`j/k:select` → ${keys(["j","k"])}:select），
		  // 字面量随之消失，只能按新形态另写一条。
		  alts: [
		    { find: "`${n}1:agents  2:activity  ${zt([\"j\",\"k\"])}/wheel:select  ${zt([\"pageUp\",\"pageDown\"])}:details  ${we(\"enter\")}/click:open  ${we(\"t\")}:${s}  ${we(\"r\")}:revive  ${we(\"x\")}:kill  ${we(\"escape\")}:close`",
		      replace: `${FN_FRAG}(\`\${n}1:agents  2:activity  \${zt(["j","k"])}/wheel:select  \${zt(["pageUp","pageDown"])}:details  \${we("enter")}/click:open  \${we("t")}:\${s}  \${we("r")}:revive  \${we("x")}:kill  \${we("escape")}:close\`)` },
		  ] },
		{ name: "agent hub roster hint",
		  find: "cs(b.fg(\"dim\",\"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close\"),e)",
		  replace: `cs(b.fg(\"dim\",${FN_FRAG}(\"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close\")),e)`,
		  // 上游后来把快捷键提示改为动态渲染（`j/k:select` → ${keys(["j","k"])}:select），
		  // 字面量随之消失，只能按新形态另写一条。
		  alts: [
		    { find: "`1:agents  ${zt([\"j\",\"k\"])}:select  ${we(\"enter\")}:transcript  ${we(\"space\")}:follow  ${we(\"f\")}:filter  ${we(\"s\")}:scope  /:search  ${we(\"escape\")}:close`",
		      replace: `${FN_FRAG}(\`1:agents  \${zt(["j","k"])}:select  \${we("enter")}:transcript  \${we("space")}:follow  \${we("f")}:filter  \${we("s")}:scope  /:search  \${we("escape")}:close\`)` },
		  ] },
		// showError root renderer: same sink approach as status/warning.
		{ name: "error sink", find: "showError(e){let t=new re(`Error: ${e}`,1,0)", replace: `showError(e){e=${FN_FRAG}(e);let t=new re(\`Error: \${e}\`,1,0)` },
{ name: "status sink", find: "showStatus(e,t){let s=this.ctx.chatContainer.children", replace: `showStatus(e,t){e=${FN_FRAG}(e);let s=this.ctx.chatContainer.children`,
		  // v18.9: 局部变量 s→n 后首选精确失配，而短锚点的通配兜底会命中 320 个方法（不唯一）。
		  // 加一条当前拼写（含后续判别式）作为 alt，精确匹配优先命中；旧版本仍走首选。
		  alts: [{ find: 'showStatus(e,t){let n=this.ctx.chatContainer.children,s=n.length>0?n[n.length-1]:void 0,i={styleFn:t?.dim??!0?(l)=>S.fg("dim",l):void 0,toast:t?.toast}', replace: `showStatus(e,t){e=${FN_FRAG}(e);let n=this.ctx.chatContainer.children,s=n.length>0?n[n.length-1]:void 0,i={styleFn:t?.dim??!0?(l)=>S.fg("dim",l):void 0,toast:t?.toast}` }] },
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
	{ name: "keyboard shortcuts panel", find: "M8(this.ctx,\"Keyboard Shortcuts\",e)", replace: `M8(this.ctx,${FN}(\"Keyboard Shortcuts\"),${FN_FRAG}(e))`,
	  // v18.8: 面板打开调用改为 this.#o(title, content)，内容构建函数改名 nen。
	  alts: [{ find: "this.#o(\"Keyboard Shortcuts\",nen(e))", replace: `this.#o(${FN}(\"Keyboard Shortcuts\"),${FN_FRAG}(nen(e)))` }] },
	// `/hotkeys` panels: their table headers are short tokens ("Key"/"Keys",
	// "Action"), below the fragment translator's length floor, so they must be
	// wrapped at the definition site. Two panel classes carry their own copy of
	// the same table, so both spellings are anchored.
	{ name: "hotkeys table headers", find: 'cols:[{id:"keys",head:"Key"},{id:"action",head:"Action",grow:1}]', replace: `cols:[{id:"keys",head:${FN}("Key")},{id:"action",head:${FN}("Action"),grow:1}]` },
	{ name: "hotkeys table headers (alt ids)", find: 'cols:[{id:"keys",head:"Keys"},{id:"does",head:"Action",grow:1}]', replace: `cols:[{id:"keys",head:${FN}("Keys")},{id:"does",head:${FN}("Action"),grow:1}]` },
	// One hotkeys row builds its action from a keybinding lookup, so the rendered
	// text ("… (↑ when empty)") never exists as a literal and the dictionary —
	// which stores the source spelling with the word "Up" — cannot match it.
	// Wrap the template so the finished string resolves through the dictionary.
	{ name: "hotkeys browse-history action", find: 'action:`Move cursor / browse history (${Ne("up")} when empty)`', replace: `action:${FN_FRAG}(\`Move cursor / browse history (\${Ne("up")} when empty)\`)` },

	{ name: "settings panel title", find: 'oi(e,"Settings")', replace: `oi(e,${FN}("Settings"))` },
	{ name: "btw history title", find: 'oi(e,"BTW history")', replace: `oi(e,${FN}("BTW history"))` },
	// two render paths of the same panel share the literal
	{ name: "agent hub title", find: 'oi(e,"Agent Hub")', replace: `oi(e,${FN}("Agent Hub"))`, all: true },
	// composed headers: `Agent Hub · <id>` renders through the fragment
	// translator, which substitutes the `Agent Hub` piece inside the finished
	// string (full-string lookup can never match a dynamic suffix).
	{ name: "agent hub header (dot-id)", find: "`Agent Hub \\xB7 ${r.id}`", replace: `${FN_FRAG}(\`Agent Hub \\xB7 \${r.id}\`)` },
	{ name: "agent hub header (agentId)", find: "`Agent Hub ${b.sep.dot} ${this.deps.agentId}`", replace: `${FN_FRAG}(\`Agent Hub \${b.sep.dot} \${this.deps.agentId}\`)` },
	{ name: "recent logs title", find: 'oi(this.#l,"Recent Logs")', replace: `oi(this.#l,${FN}("Recent Logs"))`,
	  // v18.8: 标题改传 `new yot({title:...})` 构造参数。
	  alts: [{ find: 'new yot({title:"Recent Logs"', replace: `new yot({title:${FN}("Recent Logs")` }] },
	{ name: "move-to-directory title", find: 'oi(t,"Move to directory")', replace: `oi(t,${FN}("Move to directory"))` },
	{ name: "raw provider stream title", find: 'oi(this.#u,"Raw Provider Stream")', replace: `oi(this.#u,${FN}("Raw Provider Stream"))`,
	  // v18.8: 标题改传 `new yot({title:...})` 构造参数。
	  alts: [{ find: 'new yot({title:"Raw Provider Stream"', replace: `new yot({title:${FN}("Raw Provider Stream")` }] },
	// v18.8: 标题提取为模块级常量 jsn，三处消费（Rc({title:jsn})、
	// Ac(e,jsn)、le(jsn,{role})）。在定义点包一次即可全部生效。
	{ name: "extension control center title", find: 'oi(e,"Extension Control Center")', replace: `oi(e,${FN}("Extension Control Center"))`,
	  alts: [{ find: 'var jsn="Extension Control Center"', replace: `var jsn=${FN}("Extension Control Center")` }] },
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
	// v18.8: super() 第二参数新增 role id（omp.overlay.*），按新形态补 alts。
	{ name: "queue mode title", find: 'super("Queue Mode")', replace: `super(${FN}("Queue Mode"))`,
	  alts: [{ find: 'super("Queue Mode","omp.overlay.queue-mode")', replace: `super(${FN}("Queue Mode"),"omp.overlay.queue-mode")` }] },
	{ name: "show images title", find: 'super("Show Images")', replace: `super(${FN}("Show Images"))`,
	  alts: [{ find: 'super("Show Images","omp.overlay.show-images")', replace: `super(${FN}("Show Images"),"omp.overlay.show-images")` }] },
	{ name: "debug tools title", find: 'super("Debug Tools")', replace: `super(${FN}("Debug Tools"))` },
	{ name: "history title", find: 'super("History")', replace: `super(${FN}("History"))`,
	  alts: [{ find: 'super("History","omp.overlay.history")', replace: `super(${FN}("History"),"omp.overlay.history")` }] },
	{ name: "theme selector title", find: 'super("Theme")', replace: `super(${FN}("Theme"))`,
	  alts: [{ find: 'super("Theme","omp.overlay.theme")', replace: `super(${FN}("Theme"),"omp.overlay.theme")` }] },
	{ name: "add mcp server title", find: 'super("Add MCP Server")', replace: `super(${FN}("Add MCP Server"))`,
	  alts: [{ find: 'super("Add MCP Server","omp.overlay.mcpAdd")', replace: `super(${FN}("Add MCP Server"),"omp.overlay.mcpAdd")` }] },
	{ name: "spend rate-limit reset title", find: 'super("Spend a saved rate-limit reset")', replace: `super(${FN}("Spend a saved rate-limit reset"))`,
	  alts: [{ find: 'super("Spend a saved rate-limit reset","omp.overlay.reset-usage")', replace: `super(${FN}("Spend a saved rate-limit reset"),"omp.overlay.reset-usage")` }] },
	// both plugin panels build their sidebar label the same way and share
	// the `super("Plugins")` border title
	{ name: "plugins tab label", find: "label:`${b.icon.package} Plugins`", replace: `label:\`\${b.icon.package} \${${FN}("Plugins")}\``, all: true },
	{ name: "plugins panel title", find: 'super("Plugins")', replace: `super(${FN}("Plugins"))`, all: true,
	  // v18.8: 两个插件面板的 super 第二参数分叉（role id 与 图标常量 a9e），各补一条 alt。
	  alts: [
	    { find: 'super("Plugins","omp.overlay.plugins")', replace: `super(${FN}("Plugins"),"omp.overlay.plugins")` },
	    { find: 'super("Plugins",a9e)', replace: `super(${FN}("Plugins"),a9e)` },
	  ] },
	// Providers settings page: a tab-bar section label, not the sidebar entry
	{ name: "providers section label", find: 'new $E("Providers",', replace: `new $E(${FN}("Providers"),`,
	  // v18.8: Providers 改为 settings tab 映射的 label 属性。
	  alts: [{ find: 'providers:{label:"Providers",icon:"tab.providers"}', replace: `providers:{label:${FN}("Providers"),icon:"tab.providers"}` }] },
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

/**
 * Multiline UI corpora ("tips.txt" welcome-screen tips, help bodies) live in
 * either a no-substitution template literal or — as upstream ships the tips
 * corpus — a plain `"..."` string constant. Both must be found, or the whole
 * corpus silently stays English: the literal scanner sees one 3.5KB key that
 * no dictionary entry can match, and the block rewriter only looked at
 * templates.
 *
 * `FN_BLOCK` splits the finished string on newlines and looks up each line, so
 * a candidate qualifies when its lines are individually translatable. The
 * 0.25 hit ratio keeps unrelated multiline strings (embedded code, JSON blobs)
 * out; subcommand examples (`# comment` + command) clear it on the comment
 * line alone.
 */
const findBlocks = (code: string, dict: Record<string, string>): BlockRewrite[] => {
	const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;
	const blocks: BlockRewrite[] = [];

	/** Cooked text of a node that is a single literal, or null. */
	const literalText = (node: AstNode): string | null => {
		if (node.type === "StringLiteral") return typeof node.value === "string" ? node.value : null;
		if (node.type !== "TemplateLiteral") return null;
		const exprs = node.expressions as unknown[] | undefined;
		const quasis = node.quasis as AstNode[] | undefined;
		if (!Array.isArray(exprs) || exprs.length !== 0 || !Array.isArray(quasis) || quasis.length !== 1) return null;
		const raw = String((quasis[0].value as { raw?: unknown } | undefined)?.raw ?? "");
		// Cook the quasi text the way the runtime will see it after the
		// template evaluates (\uXXXX escapes and \` sequences), so hits
		// are counted against the same strings FN_BLOCK will look up.
		return raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\`/g, "`");
	};

	const visit = (node: AstNode): void => {
		if (typeof node.start === "number" && typeof node.end === "number") {
			const cooked = literalText(node);
			if (cooked !== null && cooked.includes("\n") && !cooked.includes("{{")) {
				const lines = cooked.split("\n").map(l => l.trim()).filter(Boolean);
				const hits = lines.filter(l => dictGet(dict, l) !== undefined).length;
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

import { resolveAnchorSpellings } from "./tools/loose-anchor";

/** Resolve one anchor to concrete spans: exact match first, wildcard second. */
const resolveAnchor = (
	code: string,
	patch: AnchorPatch,
): { start: number; end: number; replace: string; adapted: string }[] => {
	return resolveAnchorSpellings(code, [patch, ...(patch.alts ?? [])], patch.all);
};

const report = async (): Promise<void> => {
	await migrateBackups();
	const dict = await loadDict();
	// Dry-run against the pristine bundle when the installed one is already
	// patched: on a patched file every wrapped call arg is a dict key again,
	// which double-classifies targets and buries the real verdicts.
	const pristine = await pristinePath();
	const installed = await readBundle(CLI_PATH);
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

/**
 * Resolve every anchor against `code`, absorbing minifier renames (wildcard
 * capture) and upstream refactors (obsolete/rescue). Returns the concrete
 * rewrite sites plus the diagnostics the caller logs. Throws when an anchor
 * cannot be satisfied at all — a real regression must fail loud.
 */
interface AnchorPlan {
	anchorOps: { start: number; end: number; wrap: null; kind: "anchor"; name: string; replace: string; adapted?: string }[];
	obsoleteAnchors: string[];
	rescuedKeys: Set<string>;
	rescuedAnchors: string[];
	rescuedOps: { start: number; end: number; key: string }[];
	adapted: { name: string; detail: string }[];
}

const planAnchors = (code: string, occurrences: Map<string, Occurrence[]>, verdicts: KeyVerdict[]): AnchorPlan => {
	const anchorOps: AnchorPlan["anchorOps"] = [];
	const obsoleteAnchors: string[] = [];
	const rescuedKeys = new Set<string>();
	const rescuedAnchors: string[] = [];
	const rescuedOps: AnchorPlan["rescuedOps"] = [];
	const adapted: AnchorPlan["adapted"] = [];
	const RESCUE_SAFE = (role: string): boolean =>
		DIRECT_ROLES[role] === true || role === "arrayElem" || role === "other" ||
		role === "groupKey" || role === "groupArrayElem";
	for (const patch of ANCHOR_PATCHES) {
		const hits = resolveAnchor(code, patch);
		if (hits.length === 0) {
			// A missing span is not always a regression: upstream may have
			// refactored the call site into a display property the scan already
			// translates. Judge by whether the keys survive. Every spelling is
			// considered — an alt may carry the literals the current build uses.
			const keys = [patch, ...(patch.alts ?? [])]
				.flatMap(s => [...s.replace.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map(m => m[1]));
			const covered = keys.length > 0 && keys.every(k =>
				verdicts.some(v => v.key === k && v.translate.length > 0));
			if (covered) {
				console.warn(`anchor obsolete (key covered by scan): ${patch.name}`);
				obsoleteAnchors.push(patch.name);
				continue;
			}
			const keyOccs = keys.map(k => ({ key: k, occs: occurrences.get(k) ?? [] }));
			const rescuable = keyOccs.length > 0 &&
				keyOccs.every(({ occs }) => occs.length > 0 && occs.every(o => RESCUE_SAFE(o.role)));
			if (rescuable) {
				rescuedAnchors.push(patch.name);
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
			if (hit.adapted) {
				console.log(`anchor adapted: ${patch.name} (${hit.adapted})`);
				adapted.push({ name: patch.name, detail: hit.adapted });
			}
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
	return { anchorOps, obsoleteAnchors, rescuedKeys, rescuedAnchors, rescuedOps, adapted };
};

const apply = async (): Promise<void> => {
	await migrateBackups();
	const dict = await loadDict();
	const code = await readBundle(CLI_PATH);
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
	const { anchorOps, obsoleteAnchors, rescuedKeys, rescuedAnchors, rescuedOps, adapted: adaptedAnchors } = planAnchors(code, occurrences, verdicts);

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
		if (FORBIDDEN_KEYS.has(en) || en.includes("{")) continue;
		// Markdown bold headers (`**Navigation**`) have no whitespace but are
		// safe fragment keys; everything else keeps the whitespace rule so
		// single tokens can never collide inside dynamic text. The length floor
		// keeps one- and two-letter tokens out of substring replacement;
		// FRAGMENT_SHORT_KEYS lists the hand-verified exceptions.
		if (!Object.hasOwn(FRAGMENT_SHORT_KEYS, en)) {
			if (en.length < 6 || (!/\s/.test(en) && !/^\*\*.+\*\*$/.test(en))) continue;
		}
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
	await makeExecutable(tmpPath, installedMode || 0o755);
	await fs.rename(tmpPath, CLI_PATH);

	const manifest = {
		appliedAt: new Date().toISOString(),
		bundleBefore: { size: code.length, sha256: sha256(code) },
		bundleAfter: { size: out.length, sha256: sha256(out) },
		keys: verdicts.filter(v => v.translate.length > 0).map(v => ({ key: v.key, zh: v.zh, occ: v.translate.length, reason: v.reason })),
		blocks: blocks.map(b => ({ start: b.start, end: b.end, hits: b.hits, lines: b.lines })),
		anchors: anchorOps.map(a => ({ name: a.name, start: a.start, len: a.end - a.start, adapted: a.adapted ?? null, replace: a.replace })),
		obsoleteAnchors,
		rescuedAnchors,
		rescuedKeys: [...rescuedKeys],
		valueLabels: Object.keys(VALUE_LABELS).length,
		ops: ops.length,
		backup: backupPath,
	};
	await Bun.write(path.join(WORK, "manifest.json"), JSON.stringify(manifest, null, 2));

	console.log(`patched ${ops.length} literal sites + ${anchorOps.length} anchor sites (${manifest.keys.length} keys)`);
	console.log(`size ${(code.length / 1e6).toFixed(2)}MB → ${(out.length / 1e6).toFixed(2)}MB`);
	console.log(`backup → ${backupPath}`);

	// Sidecar installs run through the `omp-zh` launcher, which prefers a
	// precompiled binary when one is present and fresh. Rebuild it here so a
	// fresh order of `apply` always leaves the fast path in place; a failure is
	// reported and the launcher silently keeps using the JS bundle.
	if (TARGET.kind === "sidecar" && TARGET.version) {
		// A previously compiled binary predates this patch, so it must go
		// before anything checks freshness, or it would keep serving the old
		// UI and shadow the bundle we just wrote.
		const stale = nativeBinaryPath(TARGET.version);
		if (existsSync(stale)) await fs.rm(stale, { force: true });
		await compileNative(CLI_PATH, TARGET.version);
	}
};

const verify = async (): Promise<void> => {
	const code = await readBundle(CLI_PATH);
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
	let rescuedAnchors: string[] = [];
	try {
		const manifest = await Bun.file(path.join(WORK, "manifest.json")).json() as {
			anchors?: { name?: string; replace?: string }[];
			obsoleteAnchors?: string[];
			rescuedAnchors?: string[];
		};
		if (Array.isArray(manifest.anchors) && manifest.anchors.every(a => typeof a.replace === "string")) {
			appliedAnchors = manifest.anchors.map(a => ({ name: a.name ?? "?", replace: a.replace as string }));
		}
		if (Array.isArray(manifest.obsoleteAnchors)) obsoleteAnchors = manifest.obsoleteAnchors;
		if (Array.isArray(manifest.rescuedAnchors)) rescuedAnchors = manifest.rescuedAnchors;
	} catch { /* no manifest: fall back to the literal templates */ }
	for (const patch of ANCHOR_PATCHES) {
		if (obsoleteAnchors.includes(patch.name) || rescuedAnchors.includes(patch.name)) { anchorsOk++; continue; }
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
	if (TARGET.kind === "sidecar" && TARGET.launcher) {
		console.log(`这是二进制安装的侧载运行时（${TARGET.version}）——原 omp 二进制从未被修改。`);
		console.log(`还原即可回到英文：OMP_ZH=0 ${TARGET.launcher}   （或删除 ${SIDECAR_ROOT}）`);
	}
	const backups = await listBackupEntries();
	if (backups.length === 0) throw new Error(`no backups found in ${backupDirs().join(" or ")}`);
	// Guard against version regressions: a stale backup (an older release
	// sitting next to a freshly upgraded install) must never be written back.
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
	await makeExecutable(CLI_PATH, mode);
	console.log(`restored ${(data.length / 1e6).toFixed(2)}MB from ${newest}`);

	// The precompiled binary embeds the patched bundle, so leaving it behind
	// would keep serving the Chinese UI after a "restore to English" — the
	// launcher prefers it whenever it is newer than cli.js. Remove it so both
	// paths agree on the restored (English) bundle.
	if (TARGET.kind === "sidecar" && TARGET.version) {
		const stale = nativeBinaryPath(TARGET.version);
		if (existsSync(stale)) {
			await fs.rm(stale, { force: true });
			console.log(`removed precompiled binary (it embedded the patched bundle): ${stale}`);
		}
	}
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

/**
 * `probe --keys <file>` — batch verdicts for a candidate list.
 *
 * `tools/translate.ts` is about to spend model calls on a gap list, and some
 * gap keys can never be rewritten: the same text also sits in a logic/identity
 * position, so `decideAll` bans the key wholesale and adding a dictionary entry
 * changes nothing. Translating those wastes calls and pollutes the dictionary
 * with entries that are inert forever. This prints the real verdict per key so
 * the caller can drop them *before* translating.
 *
 * Candidate keys are not in the dictionary yet, and `scanBundle` only collects
 * dictionary-matched literals — so a plain scan reports "no occurrences" for
 * every candidate. The verdicts are therefore computed against the dictionary
 * with the candidates temporarily injected, which is exactly the state that
 * would exist after translating them. Nothing is written: the merged table
 * lives in memory only.
 *
 * Reads a JSON array of keys (or a gap file with `.entries[].key`) from the
 * path given after `--keys`, writes `{source, verdicts[]}` to stdout.
 */
const probeBatch = async (keysPath: string): Promise<void> => {
	await migrateBackups();
	const raw = await Bun.file(keysPath).json() as unknown;
	const keys: string[] = Array.isArray(raw)
		? (raw as string[])
		: ((raw as { entries?: { key?: string }[] }).entries ?? []).map(e => e.key ?? "").filter(k => k !== "");
	const dict = await loadDict();
	const pristine = await pristinePath();
	if (pristine === null) {
		// Without English originals every verdict would be wrong; fail loud
		// rather than silently reporting "everything translatable".
		throw new Error(`pristine backup missing in ${backupDirs().join(" or ")}`);
	}
	const code = await Bun.file(pristine).text();
	// Inject a placeholder so the scanner sees each candidate as a dictionary
	// key. The value never reaches the output; only the role classification of
	// its occurrences matters here.
	const probeDict: Record<string, string> = { ...dict };
	for (const key of keys) if (!Object.hasOwn(probeDict, key)) probeDict[key] = key;
	const { occurrences } = scanBundle(code, probeDict);
	const verdicts = decideAll(occurrences, probeDict);
	const byKey = new Map(verdicts.map(v => [v.key, v]));
	const out = keys.map(key => {
		const v = byKey.get(key);
		return {
			key,
			reason: v?.reason ?? "no-occurrence",
			translatable: (v?.translate.length ?? 0) > 0,
			translate: v?.translate.length ?? 0,
			skipped: v?.skipped.length ?? 0,
		};
	});
	process.stdout.write(JSON.stringify({ source: pristine, verdicts: out }, null, 2) + "\n");
};

/**
 * `check [--code <path>]` — dry-run the full pipeline against a bundle
 * without writing anything. Used by CI to probe a fresh upstream release:
 * exits non-zero when anchors cannot be adapted, and prints the untranslated
 * display strings so the dictionary gap is visible in the issue.
 */
const check = async (codePath?: string, jsonPath?: string): Promise<void> => {
	const dict = await loadDict();
	let target = codePath ?? CLI_PATH;
	let code = await readBundle(target);
	// An already-patched bundle fails every anchor (the spans now carry helper
	// calls) and the resulting "anchor missing" is indistinguishable from a
	// real upstream regression. Detect the patch marker whatever path was
	// given, and fall back to the pristine backup next to it. Without this, a
	// CI job or a maintainer who points `--code` at the installed file gets a
	// bogus hard failure.
	if (code.includes(`var ${DICT_VAR}=`)) {
		const pristine = codePath === undefined
			? await pristinePath()
			: await newestPristineBeside(target);
		if (pristine !== null) {
			console.log(`(${path.basename(target)} is already patched — checking ${path.basename(pristine)})`);
			target = pristine;
			code = await readBundle(target);
		} else {
			throw new Error(
				`${target} is already patched and no pristine backup was found beside it\n` +
				`  restore first: OMP_PKG=… bun patch.ts restore\n` +
				`  or point --code at an unpatched bundle`,
			);
		}
	}
	console.log(`checking ${target} (${(code.length / 1e6).toFixed(2)}MB)`);

	const { occurrences } = scanBundle(code, dict);
	const verdicts = decideAll(occurrences, dict);
	const blocks = findBlocks(code, dict);
	const ops = collectOps(verdicts, blocks);
	const { anchorOps, obsoleteAnchors, rescuedAnchors } = planAnchors(code, occurrences, verdicts);
	const { ops: tmplOps, missing: tmplMissing } = locateTemplates(code);

	const trans = verdicts.filter(v => v.translate.length > 0);
	const transOcc = trans.reduce((a, v) => a + v.translate.length, 0);
	console.log(`literal sites: ${ops.length} (${trans.length} keys / ${transOcc} occ) | blocks: ${blocks.length} | template wraps: ${tmplOps.length}`);

	// Gaps: display-position English the dictionary does not cover yet. These
	// are the strings that would stay English after applying, so CI reports
	// them for translation instead of failing outright.
	// Real gap detection: `verdicts` only covers literals that are already in
	// the dictionary, so it can never report a missing key. Ask the gap
	// extractor (same role classifier) to scan the bundle for display-position
	// English that has no entry yet.
	const gaps: string[] = [];
	let gapEntries: { key: string; role: string; via: string; count: number; snippet: string }[] = [];
	try {
		const tmp = path.join(os.tmpdir(), `omp-zh-gaps-${process.pid}.json`);
		const proc = Bun.spawnSync(["bun", path.join(WORK, "tools", "extract-gaps.ts"), "--json", tmp], {
			env: { ...process.env, OMP_ZH_SRC: target },
			stdout: "ignore",
			stderr: "pipe",
		});
		if (proc.exitCode === 0) {
			const parsed = JSON.parse(await Bun.file(tmp).text()) as { entries: typeof gapEntries };
			gapEntries = parsed.entries;
			gaps.push(...gapEntries.map(e => e.key));
			await fs.rm(tmp, { force: true });
		} else {
			console.warn(`gap scan failed (exit ${proc.exitCode}): ${proc.stderr.toString().slice(0, 200)}`);
		}
	} catch (e) {
		console.warn(`gap scan unavailable: ${e instanceof Error ? e.message : e}`);
	}
	if (gaps.length) {
		console.log(`\ndictionary gaps (${gaps.length}):`);
		for (const g of gaps.slice(0, 200)) console.log(`  ${JSON.stringify(g)}`);
	}
	if (jsonPath) {
		await Bun.write(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), source: target, entries: gapEntries }, null, 2));
		console.log(`wrote ${gapEntries.length} gaps → ${jsonPath}`);
	}
	if (tmplMissing.length) {
		console.log(`\ntemplate targets missing (${tmplMissing.length}):`);
		for (const t of tmplMissing) console.log(`  ${t}`);
	}
	// Count covered *entries*, not sites: an `all: true` anchor rewrites several
	// spans, so adding site counts to the obsolete/rescued tallies overshoots
	// ANCHOR_PATCHES.length and makes a healthy run look wrong.
	const anchorEntriesOk = new Set([
		...anchorOps.map(a => a.name),
		...obsoleteAnchors,
		...rescuedAnchors,
	]).size;
	console.log(`\nsummary: anchors ${anchorEntriesOk}/${ANCHOR_PATCHES.length} entries ok (${anchorOps.length} sites, ${obsoleteAnchors.length} obsolete, ${rescuedAnchors.length} rescued), ${tmplMissing.length} template targets missing, ${gaps.length} dictionary gaps`);
	// Template targets are structural, like anchors: each one is a known UI
	// surface (the settings footer) that no literal rewrite can reach. Losing
	// one means that surface silently stays English, which is exactly the
	// failure mode this gate exists to catch — so it fails hard, not as a
	// dictionary-gap warning. Upstream removing the surface is handled by
	// updating TEMPLATE_TARGETS in the same commit.
	if (tmplMissing.length) process.exitCode = 1;
	else if (gaps.length) {
		// Dictionary gaps are soft: the patch still applies and only these
		// strings stay English until the dictionary catches up.
		process.exitCode = 2;
	}
};

/**
 * `doctor` — print everything needed to diagnose an install problem: the
 * resolved bundle, its shape, whether backups exist, which omp version is
 * installed, and the first bytes of the file (binary detection). Written for
 * issue reports where "it fails" is all we get.
 */
const doctor = async (): Promise<void> => {
	console.log(`platform: ${process.platform} ${process.arch}`);
	console.log(`bun: ${Bun.version}`);
	// Keep Windows environment details copy-pasteable for install diagnostics.
	if (IS_WINDOWS) {
		console.log(`env HOME/USERPROFILE: ${process.env.HOME ?? "(unset)"} / ${process.env.USERPROFILE ?? "(unset)"}`);
		console.log(`env APPDATA/LOCALAPPDATA: ${process.env.APPDATA ?? "(unset)"} / ${process.env.LOCALAPPDATA ?? "(unset)"}`);
		console.log(`PATHEXT: ${process.env.PATHEXT ?? "(unset)"}`);
		const sh = Bun.which("sh");
		console.log(`which sh: ${sh ?? "(not on PATH)"}  (.cmd launcher uses Bun directly)`);
	} else {
		console.log(`SHELL: ${process.env.SHELL ?? "(unset)"}`);
	}
	console.log(`install kind: ${TARGET.kind}${TARGET.version ? ` (omp ${TARGET.version})` : ""}`);
	if (TARGET.launcher) console.log(`launcher: ${TARGET.launcher}`);
	console.log(`CLI path: ${CLI_PATH}`);
	console.log(`  exists: ${existsSync(CLI_PATH)}`);
	console.log(`OMP_PKG env: ${process.env.OMP_PKG ?? "(unset)"}`);
	try {
		const fromPath = Bun.which("omp");
		console.log(`which omp: ${fromPath ?? "(not on PATH)"}`);
		if (fromPath) {
			// On Windows this is normally a .cmd/.ps1 wrapper, not the bundle.
			// Print what it is and where it points, because "the patcher picked
			// up omp.cmd" is the single most likely cause of a Windows failure.
			console.log(`  looks like shell shim: ${isShellShim(fromPath)}`);
			try { console.log(`  realpath: ${realpathSync(fromPath)}`); } catch { /* ignore */ }
			if (isShellShim(fromPath)) {
				const resolved = await cliFromShim(fromPath);
				console.log(`  resolved bundle from shim: ${resolved ?? "(could not parse — report this)"}`);
			}
		}
	} catch { /* ignore */ }
	console.log(`package: ${PKG}`);
	try {
		const pkg = await Bun.file(path.join(PKG, "package.json")).json() as { version?: string };
		console.log(`  version: ${pkg.version ?? "?"}`);
	} catch {
		console.log("  package.json: unreadable");
	}
	if (!existsSync(CLI_PATH)) {
		// Everything below reads the bundle; without it the report would be a
		// stack trace instead of the diagnostics the user came for.
		console.log(`bundle: MISSING at ${CLI_PATH}`);
		console.log(TARGET.kind === "sidecar"
			? "  hint: doctor is read-only; run bun patch.ts apply to download and patch this version"
			: "  hint: install omp first, or set OMP_PKG to the package dir");
		const backups0 = await listBackupEntries();
		console.log(`backups (${backups0.length})`);
		return;
	}
	const bytes = new Uint8Array(await Bun.file(CLI_PATH).arrayBuffer());
	console.log(`bundle: ${(bytes.length / 1e6).toFixed(2)}MB`);
	const nul = bytes.subarray(0, 512).filter(b => b === 0).length;
	const head = new TextDecoder().decode(bytes.subarray(0, 120)).split("\n")[0];
	console.log(`  first line: ${JSON.stringify(head.slice(0, 100))}`);
	console.log(`  NUL bytes in first 512: ${nul}${nul > 0 ? "  <-- binary, not a JS bundle" : ""}`);
	const text = new TextDecoder().decode(bytes);
	console.log(`  patched: ${text.includes(`var ${DICT_VAR}=`)}`);
	try {
		parse(text, { sourceType: "module", errorRecovery: true });
		console.log("  parses: yes");
	} catch (e) {
		console.log(`  parses: NO — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
	}
	const backups = await listBackupEntries();
	console.log(`backups (${backups.length}):`);
	for (const b of backups.sort((a, b2) => b2.mtimeMs - a.mtimeMs)) {
		console.log(`  ${b.name}  ${new Date(b.mtimeMs).toISOString()}  ${b.dir}`);
	}
	// The launcher is only useful when the shell can find it. Report both the
	// link and whether its directory is exported, because "patched but still
	// English" almost always means the user ran plain `omp`.
	if (TARGET.launcher) {
		console.log(`launcher dir on PATH: ${dirOnPath(LAUNCHER_DIR)}`);
		for (const dir of USER_BIN_DIRS) {
			const dest = path.join(dir, IS_WINDOWS ? "omp-zh.cmd" : "omp-zh");
			const stat = await fs.lstat(dest).catch(() => null);
			console.log(`  ${dest}: ${stat ? (stat.isSymbolicLink() ? "symlink" : "present") : "absent"}  (dir on PATH: ${dirOnPath(dir)})`);
		}
		const fromPath = Bun.which("omp-zh");
		console.log(`which omp-zh: ${fromPath ?? "(not on PATH)"}`);
	} else {
		console.log(`install kind is ${TARGET.kind}: plain \`omp\` is patched in place, no launcher needed`);
	}
};

const command = process.argv[2] ?? "report";
if (command === "doctor") {
	await doctor();
} else if (command === "path") {
	console.log(CLI_PATH);
} else if (command === "check") {
	const codeIdx = process.argv.indexOf("--code");
	const jsonIdx = process.argv.indexOf("--json");
	await check(
		codeIdx === -1 ? undefined : process.argv[codeIdx + 1],
		jsonIdx === -1 ? undefined : process.argv[jsonIdx + 1],
	);
} else if (command === "migrate") {
	const before = await listBackupEntries();
	await migrateBackups();
	const after = await listBackupEntries();
	const copied = after.length - before.length;
	console.log(`backups: ${after.length} in ${PRIMARY_BACKUP_DIR}${copied > 0 ? ` (+${copied} migrated)` : ""}`);
} else
if (command === "report") await report();
else if (command === "apply") await apply();
else if (command === "native") {
	if (TARGET.kind !== "sidecar" || !TARGET.version) {
		console.error("native: 仅二进制安装（侧载）需要预编译，就地安装的 JS 产物已是最优路径");
		process.exit(1);
	}
	const built = await compileNative(CLI_PATH, TARGET.version);
	if (!built) process.exit(1);
}
else if (command === "verify") await verify();
else if (command === "restore") await restore();
else if (command === "list") await listBackups();
else if (command === "probe") {
	const keysIdx = process.argv.indexOf("--keys");
	if (keysIdx !== -1) {
		const keysPath = process.argv[keysIdx + 1];
		if (!keysPath) {
			console.error("usage: bun patch.ts probe --keys <keys.json>");
			process.exit(1);
		}
		await probeBatch(keysPath);
	} else {
		await probe(process.argv.slice(3));
	}
}
else {
	console.error(`unknown command: ${command} (report|apply|verify|restore|list|probe|path|check|migrate|doctor|native)`);
	process.exit(1);
}
