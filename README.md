# Legion Stats

GNOME Shell 50 extension for a Lenovo Legion laptop. The top bar shows one compact item (`CPU 12% · 53°`). Hovering it opens a card styled after Lenovo Legion Toolkit's tray tooltip:

- ACPI platform profile
- CPU: usage, average frequency, temperature, fan
- Discrete NVIDIA GPU: state, usage and VRAM, clock and temperature, power and P-state, fan
- System: RAM, NVMe temperatures, battery level, status and power draw

The dGPU is only queried through `nvidia-smi` while the card is open and the card's runtime status is `active`, so the bar never wakes it.

## Install

    mkdir -p ~/.local/share/gnome-shell/extensions
    git clone <this repo> ~/.local/share/gnome-shell/extensions/legion-stats@beltra.local
    # log out and back in (Wayland), then:
    gnome-extensions enable legion-stats@beltra.local

## Notes

- hwmon devices are resolved by name (`coretemp`, `lenovo_wmi_other`, `nvme`) when the extension is enabled.
- `fan2` is assumed to be the GPU fan.
- CPU package power is not shown: the Intel RAPL counter is root-only.
