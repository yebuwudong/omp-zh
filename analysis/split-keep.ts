const v: any = await Bun.file("/home/yebu/oh-my-pi-cn-work/patcher/verdict.json").json();
const perKey = v.perKey as Record<string, {n:number;logic:number;tok:number;ctx:string}>;
const single: string[] = [], multi: string[] = [];
for (const k of v.keep as string[]) (/\s/.test(k) ? multi : single).push(k);
const occ = (ks: string[]) => ks.reduce((a,k)=>a+perKey[k].n,0);
console.log(`KEEP multi-word: ${multi.length} keys, ${occ(multi)} occurrences`);
console.log(`KEEP single-word: ${single.length} keys, ${occ(single)} occurrences`);
console.log(`\n-- ALL single-word KEEP (sorted by occurrences) --`);
for (const k of single.sort((a,b)=>perKey[b].n-perKey[a].n)) console.log(`  ${String(perKey[k].n).padStart(4)}  ${JSON.stringify(k)}`);
