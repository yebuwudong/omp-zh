const dict: Record<string,string> = await Bun.file("dict.json").json();
const tips = [
  `Tired of typing "keep going"? Just send a '.'`,
  "You can /btw to ask a side question",
  "Use /tan to fork the current conversation into a background agent",
];
for (const t of tips) console.log(`${JSON.stringify(t)} -> ${JSON.stringify(dict[t] ?? "(miss)")}`);
// count dict keys containing spaces and length>40 (likely sentences)
const sent = Object.keys(dict).filter(k => k.length > 40 && /\s/.test(k));
console.log(`\ndict sentence-like keys: ${sent.length}`);
