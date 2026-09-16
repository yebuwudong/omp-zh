#!/bin/bash
# Launch omp in a PTY, capture the welcome screen, then quit.
cd /tmp && mkdir -p omp-zh-test && cd omp-zh-test
export TERM=xterm-256color
timeout 25 script -qec "/home/yebu/.bun/bin/omp --no-session" /tmp/omp-tui-capture.txt < /dev/null > /dev/null 2>&1
echo "exit=$?"
