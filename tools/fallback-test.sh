#!/bin/bash
mkdir -p /tmp/omp-zh-fb && cd /tmp/omp-zh-fb
export TERM=xterm-256color
export OMP_ZH=0
( sleep 7; printf '\003'; sleep 2; printf '\003'; sleep 1 ) | timeout 25 script -qec "/home/yebu/.bun/bin/omp --no-session" /tmp/omp-fb.txt > /dev/null 2>&1
echo done
