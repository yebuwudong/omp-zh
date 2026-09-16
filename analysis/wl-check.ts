const dict: Record<string,string> = await Bun.file("dict.json").json();
const wl: string[] = await Bun.file("whitelist.json").json();
const wlSet = new Set(wl);
const probe = ["Settings","Auto","Enabled","On","Off","All","Yes","No","Read","Write","Done","Back","Close","Theme","Display","Input","Thinking","Bash","LSP","Git","GitHub","Memory","Files","Tasks","Tools","Model","Prompt","Agent","Providers","Interaction","Context","Shell","Appearance","Composer"];
console.log("key            inDict  zh              inWhitelist");
for (const k of probe) {
  const z = dict[k];
  console.log(`${k.padEnd(14)} ${z?"YES  ":"no   "} ${JSON.stringify(z ?? "").padEnd(15)} ${wlSet.has(k) ? "YES" : ""}`);
}
console.log(`\nwhitelist size: ${wl.length}`);
console.log(`whitelist entries that are single words: ${wl.filter(s=>!/\s/.test(s)).length}`);
console.log(wl.filter(s=>!/\s/.test(s)).map(s=>JSON.stringify(s)).join(" "));
