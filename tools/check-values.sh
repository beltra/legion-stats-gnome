#!/bin/sh
# Print reference readings to compare by eye with the hover card.
# Open the card and run this at the same time; values move, so expect small drift.
# CPU usage: compare with the %Cpu(s) line of top (100 - id), averaged over the bar interval.
set -u
echo "== CPU usage (top, 3 s sample)"; top -bn2 -d3 | grep '^%Cpu' | tail -1
echo "== CPU frequency (average of online CPUs, MHz)"; awk -F: '/^cpu MHz/{s+=$2;n++} END{if(n) printf "%.0f\n", s/n}' /proc/cpuinfo
echo "== Temperatures, fans (sensors)"; sensors 2>/dev/null | grep -Ei 'package id|tctl|tdie|composite|fan|^[a-z].*-' || echo "lm-sensors not installed"
echo "== Memory (free: used = total - available)"; free -b | awk '/^Mem/{printf "%.1f GB / %.1f GB (%.0f%%)\n", ($2-$7)/1e9, $2/1e9, 100*($2-$7)/$2}'
echo "== Battery"; for b in /sys/class/power_supply/*; do [ "$(cat $b/type)" = Battery ] && echo "$b: $(cat $b/capacity)% $(cat $b/status) power_now=$(cat $b/power_now 2>/dev/null)"; done
echo "== Platform profile"; cat /sys/firmware/acpi/platform_profile 2>/dev/null
echo "== GPU"; for d in /sys/bus/pci/devices/*; do case $(cat $d/class) in 0x03*) echo "$d vendor=$(cat $d/vendor) boot_vga=$(cat $d/boot_vga 2>/dev/null) runtime=$(cat $d/power/runtime_status)";; esac; done
echo "(nvidia-smi is not run here unless the dGPU is already active, to avoid waking it)"
for d in /sys/bus/pci/devices/*; do
    [ "$(cat $d/vendor)" = 0x10de ] && [ "$(cat $d/power/runtime_status)" = active ] &&
        nvidia-smi -i "${d##*/}" --query-gpu=utilization.gpu,memory.used,memory.total,clocks.sm,temperature.gpu,power.draw,pstate --format=csv
done
exit 0
