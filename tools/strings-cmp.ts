import { parse } from "@babel/parser";
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
  visit(ast);
  sets[ver] = out;
  console.log(ver, out.size, "distinct string literals");
}
console.log();
for (const [a,b] of [['18.2.1','18.2.2'],['18.2.2','18.2.4'],['18.2.4','18.2.5']]) {
  const A = sets[a], B = sets[b];
  const common = [...A].filter(x => B.has(x)).length;
  const removed = [...A].filter(x => !B.has(x));
  const added = [...B].filter(x => !A.has(x));
  console.log(`${a}->${b}: ${common} common, ${removed.length} removed, ${added.length} added (of ${A.size} base)`);
  console.log(`   survival ${(common/A.size*100).toFixed(1)}%`);
  if (removed.length) console.log('   sample removed:', removed.slice(0,5).map(s=>JSON.stringify(s.slice(0,50))).join(' | '));
  if (added.length) console.log('   sample added:', added.slice(0,5).map(s=>JSON.stringify(s.slice(0,50))).join(' | '));
}
