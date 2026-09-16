const v: any = await Bun.file("/home/yebu/oh-my-pi-cn-work/patcher/verdict.json").json();
const perKey = v.perKey as Record<string, {n:number;logic:number;tok:number;ctx:string}>;
const single = (v.keep as string[]).filter((k:string) => !/\s/.test(k));
const riskyOnes = ["Auto","On","Off","All","Yes","No","Ask","Error","More","None","Default","Read","Write","Tools","Usage","Theme","Model","Agent","None","Close","Back","Done","Cancel","Save","Reset","Select","Language","English"];
console.log("| key | occ | logic | token | first ctx |");
console.log("|---|---|---|---|---|");
for (const k of single.sort((a,b)=>perKey[b].n-perKey[a].n)) {
  const s = perKey[k];
  const flag = riskyOnes.includes(k) ? " ⚠" : "";
  console.log(`| ${JSON.stringify(k)}${flag} | ${s.n} | ${s.logic} | ${s.tok} | ${s.ctx} |`);
}
