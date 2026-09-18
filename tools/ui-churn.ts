import { parse } from "@babel/parser";
import * as fs from "node:fs";
const paths: Record<string,string> = {
  '18.2.1': '/home/yebu/omp-zh/backup/cli.js.orig-pristine',
  '18.2.2': '/home/yebu/omp-zh/backup/cli.js.orig-2026-09-16T22-06-09-708Z',
  '18.2.4': '/home/yebu/omp-zh/backup/cli.js.orig-2026-09-17T12-49-09-951Z',
  '18.2.5': '/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/.omp-zh-backup/cli.js.orig-2026-09-18T07-05-54-474Z',
};
const sets: Record<string, Set<string>> = {};
for (const [ver, p] of Object.entries(paths)) {
  const code = await Bun.file(p).text();
  const ast = parse(code, { sourceType: "module", errorRecovery: true }) as any;
  const out = new Set<string>();
  const visit = (n: any) => {
    if (n.type === "StringLiteral" && typeof n.value === "string" && n.value.length > 0) out.add(n.value);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") visit(c); }
      else if (v && typeof v.type === "string") visit(v);
    }
  };
  visit(ast); sets[ver] = out;
}
for (const [a,b] of [['18.2.1','18.2.2'],['18.2.2','18.2.4'],['18.2.4','18.2.5']]) {
  const A = sets[a], B = sets[b];
  const removed = [...A].filter(x => !B.has(x));
  const added = [...B].filter(x => !A.has(x));
  // UI-shaped: contains a space or sentence punctuation, length>=8 -> potential display strings
  const ui = (s: string) => /\s/.test(s) && s.length >= 8;
  console.log(`${a}->${b}: removed ${removed.length} (UI-shaped ${removed.filter(ui).length}), added ${added.length} (UI-shaped ${added.filter(ui).length})`);
}
