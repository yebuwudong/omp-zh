#!/bin/bash
mkdir -p /tmp/omp-zh-settings && cd /tmp/omp-zh-settings
export TERM=xterm-256color
# type /config or /settings then capture, then Esc, then quit
( sleep 7; printf '/settings'; sleep 3; printf '\r'; sleep 4; printf '\033'; sleep 1; printf '\003'; sleep 2; printf '\003'; sleep 1 ) | timeout 35 script -qec "/home/yebu/.bun/bin/omp --no-session" /tmp/omp-settings.txt > /dev/null 2>&1
echo done
