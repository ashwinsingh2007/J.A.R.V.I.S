#!/bin/sh
# Use Mac apps outside Chrome: read a window's buttons and fields, press them,
# type, click, take a screenshot. Run with no arguments for the full list.
#   hands.sh tree [App]          -> paths, roles, labels, @x,y of the front window
#   hands.sh press <path> [App] | set <path> <text> [App]
#   hands.sh focus <App> | click <x> <y> [right|double] | type <text> | key <combo> | scroll <n> | shot | check
exec "$(dirname "$0")/../resources/jarvis-hands" "$@"
