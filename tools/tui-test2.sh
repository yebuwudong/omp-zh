#!/bin/bash
mkdir -p /tmp/omp-zh-test2 && cd /tmp/omp-zh-test2
export TERM=xterm-256color
# launch, wait for welcome, send Ctrl+C twice to exit
( sleep 6; printf '\003'; sleep 2; printf '\003'; sleep 2 ) | timeout 25 script -qec "/home/yebu/.bun/bin/omp --no-session" /tmp/omp-tui2.txt > /dev/null 2>&1
echo "done"
