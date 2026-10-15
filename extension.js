import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const BAR_INTERVAL_S = 2;
const CARD_INTERVAL_S = 1;

const dec = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? dec.decode(bytes).trim() : null;
    } catch (_e) {
        return null;
    }
}

function readNum(path) {
    const t = readText(path);
    if (t === null) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function hwmonByName(name, nth = 0) {
    let seen = 0;
    for (let i = 0; i < 32; i++) {
        const base = `/sys/class/hwmon/hwmon${i}`;
        const n = readText(`${base}/name`);
        if (n === null) continue;
        if (n === name && seen++ === nth) return base;
    }
    return null;
}

function runAsync(argv) {
    return new Promise(resolve => {
        try {
            const p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            p.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, out] = proc.communicate_utf8_finish(res);
                    resolve(proc.get_successful() ? (out ?? '').trim() : null);
                } catch (_e) {
                    resolve(null);
                }
            });
        } catch (_e) {
            resolve(null);
        }
    });
}

const fmt = (v, unit, d = 0) => v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(d)}${unit}`;
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';

export default class LegionStats extends Extension {
    enable() {
        this._coretemp = hwmonByName('coretemp');
        this._wmi = hwmonByName('lenovo_wmi_other');
        this._nvme = [hwmonByName('nvme', 0), hwmonByName('nvme', 1)];
        this._gpuPci = this._findNvidiaPci();
        this._prevStat = null;
        this._cpuPct = null;
        this._gpuQuerying = false;
        this._button = new PanelMenu.Button(0.0, 'Legion Stats', true);
        this._label = new St.Label({
            text: 'CPU —',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ls-bar',
            style: 'min-width: 6.5em; text-align: center;',
        });
        this._button.add_child(this._label);
        Main.panel.addToStatusArea('legion-stats', this._button, 0, 'right');

        this._buildCard();

        this._hoverId = this._button.connect('notify::hover', () => {
            if (this._button.hover) this._showCard();
            else this._hideCard();
        });

        this._tick();
        this._barTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, BAR_INTERVAL_S, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._barTimer) GLib.source_remove(this._barTimer);
        this._barTimer = null;
        this._stopCardTimer();
        if (this._hoverId) this._button.disconnect(this._hoverId);
        this._hoverId = null;
        if (this._card) {
            Main.layoutManager.removeChrome(this._card);
            this._card.destroy();
        }
        this._card = null;
        this._button?.destroy();
        this._button = null;
        this._label = null;
        this._rows = null;
    }

    _findNvidiaPci() {
        try {
            const dir = Gio.File.new_for_path('/sys/bus/pci/devices');
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (readText(`/sys/bus/pci/devices/${name}/vendor`) === '0x10de' &&
                    (readText(`/sys/bus/pci/devices/${name}/class`) ?? '').startsWith('0x03'))
                    return `/sys/bus/pci/devices/${name}`;
            }
        } catch (_e) { /* no pci */ }
        return null;
    }

    // ---- sampling ----
    _cpuUsage() {
        const line = (readText('/proc/stat') ?? '').split('\n')[0].split(/\s+/).slice(1).map(Number);
        if (line.length < 4) return null;
        const idle = line[3] + (line[4] ?? 0);
        const total = line.reduce((a, b) => a + b, 0);
        let pct = null;
        if (this._prevStat) {
            const dt = total - this._prevStat.total;
            const di = idle - this._prevStat.idle;
            if (dt > 0) pct = Math.max(0, Math.min(100, 100 * (1 - di / dt)));
        }
        this._prevStat = {idle, total};
        return pct;
    }

    _cpuTemp() {
        const v = this._coretemp ? readNum(`${this._coretemp}/temp1_input`) : null;
        return v === null ? null : v / 1000;
    }

    _cpuFreqMHz() {
        let sum = 0, n = 0;
        for (let i = 0; i < 64; i++) {
            const v = readNum(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
            if (v === null) break;
            sum += v; n++;
        }
        return n ? sum / n / 1000 : null;
    }

    _tick() {
        const pct = this._cpuUsage();
        if (pct !== null) this._cpuPct = pct;
        const t = this._cpuTemp();
        this._label.set_text(`CPU ${fmt(this._cpuPct, '%')} · ${fmt(t, '°')}`);
    }

    // ---- card ----
    _mkRow(parent, key) {
        const row = new St.BoxLayout({x_expand: true});
        const k = new St.Label({text: key, style_class: 'ls-key', x_expand: true});
        const v = new St.Label({text: '—', style_class: 'ls-val', x_align: Clutter.ActorAlign.END});
        row.add_child(k);
        row.add_child(v);
        parent.add_child(row);
        return {row, k, v};
    }

    _mkSection(parent, title) {
        parent.add_child(new St.Label({text: title, style_class: 'ls-section'}));
    }

    _buildCard() {
        this._card = new St.BoxLayout({vertical: true, style_class: 'ls-card', reactive: false, visible: false});
        const c = this._card;
        const r = this._rows = {};
        c.add_child(new St.Label({text: 'Legion Pro 5i', style_class: 'ls-title'}));

        r.preset = this._mkRow(c, 'Platform profile');

        this._mkSection(c, 'CPU');
        r.cpuLoad = this._mkRow(c, 'Usage');
        r.cpuFt = this._mkRow(c, 'Frequency / temp');
        r.cpuFan = this._mkRow(c, 'Fan');

        this._mkSection(c, 'DISCRETE GPU');
        r.gpuState = this._mkRow(c, 'State');
        r.gpuLoad = this._mkRow(c, 'Usage / VRAM');
        r.gpuFt = this._mkRow(c, 'Frequency / temp');
        r.gpuPower = this._mkRow(c, 'Power / P-state');
        r.gpuFan = this._mkRow(c, 'Fan');

        this._mkSection(c, 'SYSTEM');
        r.ram = this._mkRow(c, 'Memory');
        r.ssd = this._mkRow(c, 'SSD temps');
        r.bat = this._mkRow(c, 'Battery');

        Main.layoutManager.addTopChrome(c);
    }

    _showCard() {
        this._card.show();
        this._refreshCard();
        this._placeCard();
        this._stopCardTimer();
        this._cardTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CARD_INTERVAL_S, () => {
            this._refreshCard();
            this._placeCard();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _hideCard() {
        this._stopCardTimer();
        this._card?.hide();
    }

    _stopCardTimer() {
        if (this._cardTimer) GLib.source_remove(this._cardTimer);
        this._cardTimer = null;
    }

    _placeCard() {
        const [bx, by] = this._button.get_transformed_position();
        const [bw, bh] = this._button.get_size();
        const mon = Main.layoutManager.primaryMonitor;
        const cw = this._card.get_preferred_width(-1)[1];
        let x = Math.round(bx + bw / 2 - cw / 2);
        x = Math.max(mon.x + 8, Math.min(x, mon.x + mon.width - cw - 8));
        this._card.set_position(x, Math.round(by + bh + 6));
    }

    _refreshCard() {
        const r = this._rows;
        const set = (o, s) => o.v.set_text(s);

        // power
        set(r.preset, cap(readText('/sys/firmware/acpi/platform_profile')));

        // cpu
        set(r.cpuLoad, fmt(this._cpuPct, '%'));
        const f = this._cpuFreqMHz();
        set(r.cpuFt, `${f === null ? '—' : (f / 1000).toFixed(1) + ' GHz'} · ${fmt(this._cpuTemp(), '°C')}`);
        const fan = (n) => this._wmi ? readNum(`${this._wmi}/fan${n}_input`) : null;
        set(r.cpuFan, fmt(fan(1), ' RPM'));

        // gpu
        this._refreshGpu();
        set(r.gpuFan, fmt(fan(2), ' RPM'));

        // system
        const mi = {};
        for (const l of (readText('/proc/meminfo') ?? '').split('\n')) {
            const m = l.match(/^(\w+):\s+(\d+)/);
            if (m) mi[m[1]] = Number(m[2]);
        }
        if (mi.MemTotal) {
            const used = mi.MemTotal - mi.MemAvailable;
            set(r.ram, `${(used / 1048576).toFixed(1)} / ${(mi.MemTotal / 1048576).toFixed(0)} GB · ${(100 * used / mi.MemTotal).toFixed(0)}%`);
        }
        set(r.ssd, this._nvme.map(b => {
            const v = b ? readNum(`${b}/temp1_input`) : null;
            return v === null ? '—' : `${(v / 1000).toFixed(0)}°`;
        }).join(' · '));

        const bat = '/sys/class/power_supply/BAT0';
        const cp = readNum(`${bat}/capacity`);
        const st = readText(`${bat}/status`);
        const pw = readNum(`${bat}/power_now`);
        const watts = pw === null ? '' : ` · ${(pw / 1e6).toFixed(1)} W`;
        set(r.bat, `${fmt(cp, '%')} ${st ?? ''}${watts}`);
    }

    _refreshGpu() {
        const r = this._rows;
        const set = (o, s) => o.v.set_text(s);
        const rt = this._gpuPci ? readText(`${this._gpuPci}/power/runtime_status`) : null;
        if (rt === 'suspended') {
            set(r.gpuState, 'Powered off (suspended)');
            for (const k of ['gpuLoad', 'gpuFt', 'gpuPower']) set(r[k], '—');
            return;
        }
        set(r.gpuState, rt === 'active' ? 'Active' : (rt ?? 'Unknown'));
        if (rt !== null && rt !== 'active') {
            for (const k of ['gpuLoad', 'gpuFt', 'gpuPower']) set(r[k], '—');
            return;
        }
        if (this._gpuQuerying) return;
        this._gpuQuerying = true;
        runAsync(['nvidia-smi',
            '--query-gpu=utilization.gpu,memory.used,memory.total,clocks.sm,temperature.gpu,power.draw,pstate',
            '--format=csv,noheader,nounits']).then(out => {
            this._gpuQuerying = false;
            if (!this._rows || !out) return;
            const [util, mu, mt, clk, tmp, pwr, ps] = out.split(',').map(s => s.trim());
            const n = x => Number.isFinite(Number(x)) ? Number(x) : null;
            const gb = x => n(x) === null ? null : n(x) / 1024;
            set(r.gpuLoad, `${fmt(n(util), '%')} · ${fmt(gb(mu), '', 1)}/${fmt(gb(mt), '', 0)} GB`);
            set(r.gpuFt, `${fmt(n(clk), ' MHz')} · ${fmt(n(tmp), '°C')}`);
            set(r.gpuPower, `${fmt(n(pwr), ' W')} · ${ps}`);
        });
    }
}
