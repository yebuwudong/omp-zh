const dict: Record<string,string> = await Bun.file("dict.json").json();
const txt = await Bun.file("/home/yebu/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/components/tips.txt").text();
const lines = txt.split("\n").filter(Boolean);
let hit = 0;
for (const l of lines) { const t = dict[l.trim()]; if (t) hit++; else console.log(`MISS: ${l.slice(0,70)}`); }
console.log(`\ntips total=${lines.length}, hit=${hit}`);
