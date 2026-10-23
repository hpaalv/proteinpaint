#!/usr/bin/env bash
# Power-cycles the external monitor (HDMI-1-0, PRIME-driven primary). GPU test windows
# sometimes freeze its image; turning the output off and on again recovers it.
set -e
export DISPLAY="${DISPLAY:-:0}"
xrandr --output HDMI-1-0 --off
sleep 2
xrandr --output HDMI-1-0 --mode 1920x1080 --rate 60 --pos 1920x0 --primary --right-of eDP-2
