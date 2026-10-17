#!/usr/bin/env bun
/**
 * Minimal VT100 screen model.
 *
 * Reading a TUI's raw output gives escape-laden, overlapping frames; grepping it
 * tells you what the program *emitted*, not what the user *sees*. This keeps a
 * character grid and applies the handful of sequences omp's renderer uses
 * (cursor addressing, erase line/display, CR/LF/BS), so callers can ask for the
 * current screen as plain text.
 *
 * Deliberately small: SGR (colors/attributes) is ignored, scroll regions and
 * alternate-screen switching are not modelled — the settings/overlay panels this
 * is used for repaint absolutely and never scroll the terminal.
 */

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export class Screen {
	readonly rows: number;
	readonly cols: number;
	private grid: string[][];
	private r = 0;
	private c = 0;

	constructor(rows = 60, cols = 200) {
		this.rows = rows;
		this.cols = cols;
		this.grid = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
	}

	private clearRow(y: number): void {
		this.grid[y] = Array<string>(this.cols).fill(" ");
	}

	private newline(): void {
		if (this.r < this.rows - 1) this.r++;
		else {
			this.grid.shift();
			this.grid.push(Array<string>(this.cols).fill(" "));
		}
	}

	private put(ch: string): void {
		if (this.r < 0 || this.r >= this.rows) return;
		const width = WIDE.test(ch) ? 2 : 1;
		if (this.c >= this.cols) return;
		this.grid[this.r][this.c] = ch;
		for (let i = 1; i < width && this.c + i < this.cols; i++) this.grid[this.r][this.c + i] = "";
		this.c = Math.min(this.c + width, this.cols - 1);
	}

	/** Apply a chunk of terminal output. */
	write(data: string): void {
		let i = 0;
		const n = data.length;
		while (i < n) {
			const ch = data[i];
			if (ch !== "\x1b") {
				if (ch === "\r") this.c = 0;
				else if (ch === "\n") this.newline();
				else if (ch === "\b") this.c = Math.max(0, this.c - 1);
				else if (ch >= " ") this.put(ch);
				i++;
				continue;
			}
			const next = data[i + 1];
			if (next === "[") {
				const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i));
				if (!m) { i += 2; continue; }
				const params = m[1].replace(/^\?/, "");
				const nums = params === "" ? [] : params.split(";").map(Number);
				const arg = (k: number, dflt: number) => (nums[k] && nums[k] > 0 ? nums[k] : dflt);
				switch (m[2]) {
					case "H":
					case "f":
						this.r = Math.min(this.rows - 1, arg(0, 1) - 1);
						this.c = Math.min(this.cols - 1, arg(1, 1) - 1);
						break;
					case "A": this.r = Math.max(0, this.r - arg(0, 1)); break;
					case "B": this.r = Math.min(this.rows - 1, this.r + arg(0, 1)); break;
					case "C": this.c = Math.min(this.cols - 1, this.c + arg(0, 1)); break;
					case "D": this.c = Math.max(0, this.c - arg(0, 1)); break;
					case "J": {
						const mode = nums[0] ?? 0;
						if (mode === 2 || mode === 3) {
							for (let y = 0; y < this.rows; y++) this.clearRow(y);
							this.r = 0;
							this.c = 0;
						} else if (mode === 0) {
							for (let x = this.c; x < this.cols; x++) this.grid[this.r][x] = " ";
							for (let y = this.r + 1; y < this.rows; y++) this.clearRow(y);
						}
						break;
					}
					case "K": {
						const mode = nums[0] ?? 0;
						if (mode === 2) this.clearRow(this.r);
						else if (mode === 0) for (let x = this.c; x < this.cols; x++) this.grid[this.r][x] = " ";
						break;
					}
					default:
						break; // SGR and anything else: no visual effect here
				}
				i += m[0].length;
				continue;
			}
			if (next === "]") {
				// OSC: consume until BEL or ST.
				const bel = data.indexOf("\x07", i);
				const st = data.indexOf("\x1b\\", i);
				const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
				i = end === -1 ? n : end + (end === bel ? 1 : 2);
				continue;
			}
			i += 2; // charset switch etc.
		}
	}

	/** Current screen as plain text, right-trimmed, blank lines dropped. */
	text(): string {
		return this.grid
			.map(row => row.join("").replace(/\s+$/, ""))
			.filter(line => line.trim().length > 0)
			.join("\n");
	}
}
