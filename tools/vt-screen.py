import os, pty, select, time, re, sys, unicodedata

class Screen:
    def __init__(self, rows=60, cols=200):
        self.rows, self.cols = rows, cols
        self.grid = [[' ']*cols for _ in range(rows)]
        self.r = self.c = 0
    def _wide(self, ch):
        return 2 if unicodedata.east_asian_width(ch) in ('W','F') else 1
    def put(self, ch):
        if ch == '\n':
            self.r = min(self.r+1, self.rows-1); return
        if ch == '\r':
            self.c = 0; return
        if ch == '\b':
            self.c = max(0, self.c-1); return
        if self.r >= self.rows: self.grid.pop(0); self.grid.append([' ']*self.cols); self.r = self.rows-1
        w = self._wide(ch)
        if self.c < self.cols: self.grid[self.r][self.c] = ch
        for k in range(1, w):
            if self.c+k < self.cols: self.grid[self.r][self.c+k] = ''
        self.c = min(self.c+w, self.cols-1)
    def erase_line(self, mode=0):
        if mode == 0: self.grid[self.r][self.c:] = [' ']*(self.cols-self.c)
        elif mode == 2: self.grid[self.r] = [' ']*self.cols
    def erase_disp(self, mode=0):
        if mode in (2,3):
            self.grid = [[' ']*self.cols for _ in range(self.rows)]; self.r = self.c = 0
        elif mode == 0:
            self.erase_line(0)
            for i in range(self.r+1, self.rows): self.grid[i] = [' ']*self.cols
    def text(self):
        out = []
        for row in self.grid:
            line = ''.join(row).rstrip()
            if line.strip(): out.append(line)
        return '\n'.join(out)

CURSOR_RE = re.compile(r'\x1b\[(\d*);(\d*)[Hf]')
def feed(screen, data):
    i, n = 0, len(data)
    while i < n:
        ch = data[i]
        if ch == '\x1b':
            if i+1 < n and data[i+1] == '[':
                m = re.match(r'\x1b\[([0-9;?]*)([A-Za-z])', data[i:])
                if m:
                    params, cmd = m.group(1), m.group(2)
                    nums = [int(x) if x else 0 for x in params.lstrip('?').split(';')] if params.lstrip('?') else []
                    if cmd == 'H' or cmd == 'f':
                        r = (nums[0]-1) if len(nums) > 0 and nums[0] else 0
                        c = (nums[1]-1) if len(nums) > 1 and nums[1] else 0
                        screen.r, screen.c = max(0,min(r,screen.rows-1)), max(0,min(c,screen.cols-1))
                    elif cmd == 'A': screen.r = max(0, screen.r - (nums[0] if nums and nums[0] else 1))
                    elif cmd == 'B': screen.r = min(screen.rows-1, screen.r + (nums[0] if nums and nums[0] else 1))
                    elif cmd == 'C': screen.c = min(screen.cols-1, screen.c + (nums[0] if nums and nums[0] else 1))
                    elif cmd == 'D': screen.c = max(0, screen.c - (nums[0] if nums and nums[0] else 1))
                    elif cmd == 'J': screen.erase_disp(nums[0] if nums else 0)
                    elif cmd == 'K': screen.erase_line(nums[0] if nums else 0)
                    i += m.end(); continue
                else:
                    i += 2; continue
            elif i+1 < n and data[i+1] == ']':
                j = data.find('\x07', i)
                if j == -1: j = data.find('\x1b\\', i)
                i = (j+1) if j != -1 else n
                continue
            else:
                i += 2; continue
        else:
            screen.put(ch); i += 1
