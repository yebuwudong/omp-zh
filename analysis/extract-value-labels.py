#!/usr/bin/env python3
"""Extract per-setting {raw value -> display label} maps from the pristine bundle.

Mirrors what patch.ts does at runtime via __omp_i18n_vlm: option labels are run
through the dictionary (same lookup the runtime helper uses), option-less enums
fall back to the global VALUE_LABELS table.

Usage: python3 analysis/extract-value-labels.py [--json out.json]
"""
import json, re, sys

WORK = "/home/yebu/omp-zh"
txt = open(f"{WORK}/backup/cli.js.orig-pristine", encoding="utf-8").read()
d1 = json.load(open(f"{WORK}/dict.json"))
d2 = json.load(open(f"{WORK}/dict-extra.json"))
DICT = {**d1, **d2}

FORBIDDEN = {"__proto__", "constructor", "prototype"}

def brace_body(txt, start):
    """Return the balanced {...} body starting at index `start` (points at '{')."""
    depth = 0; j = start; instr = None
    while j < len(txt):
        c = txt[j]
        if instr:
            if c == "\\": j += 2; continue
            if c == instr: instr = None
        else:
            if c in "\"'`": instr = c
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0: break
        j += 1
    return txt[start:j + 1]

def options_of(obj):
    k = obj.find("options:[")
    if k == -1:
        # options created at runtime (identifier) -> submenu rows, map built from def.options at runtime
        return None
    d = 0; e = k + 8
    while e < len(obj):
        c = obj[e]
        if c == "[": d += 1
        elif c == "]":
            d -= 1
            if d == 0: break
        e += 1
    body = obj[k + 9:e]
    return [(v.encode().decode("unicode_escape"), l.encode().decode("unicode_escape"))
            for v, l in re.findall(r'\{value:"((?:[^"\\]|\\.)*)",label:"((?:[^"\\]|\\.)*)"', body)]

def labels_from_values(obj):
    m = re.search(r'values:\[([^\]]*)\]', obj)
    if not m: return []
    return [(v, v) for v in re.findall(r'"([^"]*)"', m.group(1))]

entries = {}
pat = re.compile(r'"([A-Za-z][\w.-]*)":\{')
seen = set()
for m in pat.finditer(txt):
    key = m.group(1)
    if key in seen: continue
    seen.add(key)
    obj = brace_body(txt, m.end() - 1)
    if "ui:{tab:" not in obj:
        continue
    typ_m = re.search(r'type:"(\w+)"', obj)
    if not typ_m: continue
    typ = typ_m.group(1)
    pairs = options_of(obj)
    if typ == "boolean":
        entries[key] = {"true": "是", "false": "否"}
        continue
    if pairs is None:
        # runtime options or none
        pairs = labels_from_values(obj) if typ == "enum" else []
        if pairs and ('options:' in obj and 'options:[' not in obj):
            continue  # runtime-generated labels; resolved at runtime from the same map
    if typ == "enum" and not pairs:
        pairs = labels_from_values(obj)
    if not pairs:
        continue
    out = {}
    for v, l in pairs:
        if v in FORBIDDEN: continue
        zh = DICT.get(l)
        if zh is None:
            continue
        out[v] = zh if zh != v else None
    out = {k: v for k, v in out.items() if v}
    if out:
        entries[key] = out

print(f"settings with resolvable value labels: {len(entries)}")
total = sum(len(v) for v in entries.values())
print(f"total mappings: {total}")

from collections import defaultdict
byval = defaultdict(set)
for k, mp in entries.items():
    for v, zh in mp.items():
        byval[v].add(zh)
conf = {v: zs for v, zs in byval.items() if len(zs) > 1}
print(f"values with >1 label across settings (need per-setting map): {len(conf)}")
for v, zs in sorted(conf.items())[:40]:
    print(f"  {v!r}: {sorted(zs)}")

if "--json" in sys.argv:
    out = sys.argv[sys.argv.index("--json") + 1]
    json.dump(entries, open(out, "w"), ensure_ascii=False, indent=1, sort_keys=True)
    print(f"wrote {out}")
