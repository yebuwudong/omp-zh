/**
 * Minifier-proof anchor matching.
 *
 * The bundle is re-minified on every omp release and every internal
 * identifier is renamed (`Ke` -> `$e`, `KJr` -> `qZr`), so an anchor written
 * against one build stops matching the next. These helpers compile an anchor
 * into a regex in which every identifier-shaped token becomes a wildcard
 * capture, while string literals, punctuation and property names are matched
 * verbatim. The captured spellings are then substituted into the patch's
 * replacement text, so a rename adapts automatically instead of failing the
 * apply.
 */

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;

const JS_KEYWORDS = new Set((
	"function return if else let var const new typeof instanceof in of true false null undefined " +
	"this void delete await async for while do switch case break continue throw try catch finally " +
	"yield class extends super default export import from"
).split(/\s+/));

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Index of the `}` matching the `{` at `open` (string/backtick aware). */
export const matchingBrace = (text: string, open: number): number => {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'" || c === "`") {
			i++;
			while (i < text.length) {
				if (text[i] === "\\") { i += 2; continue; }
				if (text[i] === c) break;
				i++;
			}
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
};

export interface LoosePattern {
	regex: RegExp;
	/** Identifier spellings captured, in group order. */
	names: string[];
}

/**
 * Compile an anchor into a wildcard regex. Non-identifier identifiers after a
 * dot and JS keywords stay verbatim; every other identifier-shaped token
 * becomes a capture group. Template literals are walked so `${...}`
 * interpolations are wildcarded too, while their literal text stays exact.
 */
export const compileLooseAnchor = (find: string): LoosePattern => {
	const out: string[] = [];
	const names: string[] = [];
	let i = 0;
	while (i < find.length) {
		const c = find[i];
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < find.length) {
				if (find[j] === "\\") { j += 2; continue; }
				if (find[j] === c) { j++; break; }
				j++;
			}
			out.push(escapeRe(find.slice(i, j)));
			i = j;
		} else if (c === "`") {
			let j = i + 1;
			let buf = "`";
			while (j < find.length) {
				if (find[j] === "\\") { buf += find.slice(j, j + 2); j += 2; continue; }
				if (find[j] === "`") { buf += "`"; j++; break; }
				if (find[j] === "$" && find[j + 1] === "{") {
					const close = matchingBrace(find, j + 1);
					out.push(escapeRe(buf + "${"));
					// An anchor may cut a `${...}` short (it only has to be a
					// substring of the bundle). Compile whatever follows as the
					// expression body and stop — there is no closing brace to
					// consume.
					if (close === -1) {
						const inner = compileLooseAnchor(find.slice(j + 2));
						out.push(inner.regex.source);
						names.push(...inner.names);
						buf = "";
						j = find.length;
						break;
					}
					const inner = compileLooseAnchor(find.slice(j + 2, close));
					out.push(inner.regex.source);
					names.push(...inner.names);
					out.push("}");
					buf = "";
					j = close + 1;
					continue;
				}
				buf += find[j];
				j++;
			}
			out.push(escapeRe(buf));
			i = j;
		} else if (c === "." && i + 1 < find.length && ID_START.test(find[i + 1])) {
			// Member chain: `.a.b.c` — the whole chain is one wildcard-sized
			// token. A refactor can replace `this.deps.agentId` with
			// `this.#g.agentId`, and anchoring on the property name would
			// break; capturing the chain keeps the surrounding literals exact.
			let j = i;
			while (j < find.length && find[j] === "." && j + 1 < find.length && ID_START.test(find[j + 1])) {
				j++;
				while (j < find.length && ID_CHAR.test(find[j])) j++;
				if (find[j] === "#") { j++; while (j < find.length && ID_CHAR.test(find[j])) j++; }
			}
			const chain = find.slice(i, j);
			out.push("(\\.[A-Za-z0-9_$#.]+)");
			names.push(chain);
			i = j;
		} else if (c === "#" && i + 1 < find.length && ID_START.test(find[i + 1])) {
			// Private fields (`#y`) are one token: the minifier may rename the
			// name, so capture `#name` as a unit and let renameTokens map it.
			let j = i + 1;
			while (j < find.length && ID_CHAR.test(find[j])) j++;
			const word = find.slice(i, j);
			out.push("(#[A-Za-z_$][A-Za-z0-9_$]*)");
			names.push(word);
			i = j;
		} else if (ID_START.test(c)) {
			let j = i;
			while (j < find.length && ID_CHAR.test(find[j])) j++;
			const word = find.slice(i, j);
			const prev = i > 0 ? find[i - 1] : "";
			if (prev === "." || JS_KEYWORDS.has(word)) out.push(word);
			else { out.push("([A-Za-z_$][A-Za-z0-9_$]*)"); names.push(word); }
			i = j;
		} else {
			out.push(escapeRe(c));
			i++;
		}
	}
	return { regex: new RegExp(out.join(""), "g"), names };
};

/** Replace identifier-shaped tokens word-boundary-safely. */
export const renameTokens = (text: string, renames: Map<string, string>): string => {
	const names = [...renames].filter(([from, to]) => from !== to).map(([from]) => from)
		.sort((a, b) => b.length - a.length);
	if (!names.length) return text;
	// One pass prevents o→r, r→s from accidentally rewriting o into s too.
	// Member chains/private fields include their own leading punctuation.
	const pattern = names.map(from => from.startsWith(".") || from.startsWith("#")
		? `${escapeRe(from)}(?![A-Za-z0-9_$])`
		: `(?<![A-Za-z0-9_$])${escapeRe(from)}(?![A-Za-z0-9_$])`).join("|");
	return text.replace(new RegExp(pattern, "g"), from => renames.get(from)!);
};

export interface LooseHit {
	start: number;
	end: number;
	/** Captured identifier spellings, old anchor name -> current bundle name. */
	renames: Map<string, string>;
}

/**
 * Match `find` against `code` allowing identifier renames. Returns every hit
 * with its rename map; an empty result means no structural match.
 */
export const matchLoose = (code: string, find: string): LooseHit[] => {
	const { regex, names } = compileLooseAnchor(find);
	const hits: LooseHit[] = [];
	for (const m of code.matchAll(regex)) {
		const renames = new Map<string, string>();
		for (let g = 0; g < names.length; g++) {
			const captured = m[g + 1];
			if (captured && !renames.has(names[g])) renames.set(names[g], captured);
		}
		const start = m.index ?? 0;
		hits.push({ start, end: start + m[0].length, renames });
	}
	return hits;
};

/** Human-readable rename summary for logs (`$3e→Sje`). */
export const describeRenames = (renames: Map<string, string>): string =>
	[...renames].filter(([a, b]) => a !== b).map(([a, b]) => `${a}→${b}`).join(", ");

/** Prefer a unique alternative over an ambiguous wildcard; keep ambiguity for callers to reject. */
export const resolveAnchorSpellings = (
	code: string,
	spellings: readonly { find: string; replace: string }[],
	all = false,
): { start: number; end: number; replace: string; adapted: string }[] => {
	for (const spelling of spellings) {
		const exact: { start: number; end: number; replace: string; adapted: string }[] = [];
		if (!spelling.find) continue;
		let start = 0;
		while ((start = code.indexOf(spelling.find, start)) !== -1) {
			exact.push({ start, end: start + spelling.find.length, replace: spelling.replace, adapted: "" });
			start += spelling.find.length;
		}
		if (exact.length > 0) return exact;
	}
	let ambiguous: ReturnType<typeof resolveAnchorSpellings> = [];
	for (const spelling of spellings) {
		const hits = matchLoose(code, spelling.find).map(h => ({
			start: h.start, end: h.end,
			replace: renameTokens(spelling.replace, h.renames),
			adapted: describeRenames(h.renames),
		}));
		if (hits.length === 1 || (all && hits.length > 0)) return hits;
		if (ambiguous.length === 0 && hits.length > 1) ambiguous = hits;
	}
	return ambiguous;
};
