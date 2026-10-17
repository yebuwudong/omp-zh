import os, pty, select, time, sys, re
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from vt import Screen, feed

def run(script):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"], os.environ["LINES"] = "200", "60"
        os.chdir("/home/yebu/.omp-zh")
        os.execvp("omp-zh", ["omp-zh", "--no-session"])
    scr = Screen(60, 200)
    def pump(sec):
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try: data = os.read(fd, 262144)
                except OSError: return False
                if not data: return False
                feed(scr, data.decode("utf-8", "replace"))
        return True
    pump(9)                       # 等启动
    shots = []
    for label, keys, wait in script:
        if keys: os.write(fd, keys)
        pump(wait)
        shots.append((label, scr.text()))
    try: os.kill(pid, 9)
    except: pass
    return shots

script = [
    ("settings-open", b"/settings\r", 3.5),
]
for i in range(8):
    script.append((f"tab{i}", b"\x1b[C", 1.6))
shots = run(script)
outdir = "/tmp/crawl"
os.makedirs(outdir, exist_ok=True)
for label, text in shots:
    open(f"{outdir}/{label}.txt", "w").write(text)
    # 英文行判定：含 ≥2 个英文词且无中日韩
    lines = [l for l in text.split("\n") if l.strip()]
    eng = [l for l in lines if len(re.findall(r'[A-Za-z]{3,}', l)) >= 2 and not re.search(r'[\u4e00-\u9fff]', l)]
    print(f"{label:16s} 总行 {len(lines):3d}  英文行 {len(eng):3d}")
print("输出:", outdir)
