import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const CARD_INTERVAL_S = 2;
// Longer than the usual 5 s runtime-PM autosuspend delay, so the bar's GPU
// reads do not keep an idle dGPU from suspending.
const GPU_BAR_INTERVAL_US = 10e6;
const GPU_HWMON = ['amdgpu', 'radeon', 'nouveau', 'i915', 'xe'];
const NV_FIELDS = 'utilization.gpu,memory.used,memory.total,clocks.sm,temperature.gpu,power.draw,pstate';

const dec = new TextDecoder();

// Synchronous reads are only used at enable() for discovery and for the two
// fast bar files; everything shown in the card is read asynchronously because
// some sensors (NVMe, ACPI battery) block for 10-60 ms.
function readSync(path) {
    try {
        return dec.decode(GLib.file_get_contents(path)[1]).trim();
    } catch (_e) {
        return null;
    }
}

async function read(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return dec.decode(bytes).trim();
    } catch (_e) {
        return null;
    }
}

function ls(dir) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)))
            out.push(info.get_name());
        en.close(null);
    } catch (_e) { /* missing */ }
    return out.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

const toNum = t => t === null || t === '' || Number.isNaN(Number(t)) ? null : Number(t);
const num = (v, d = 0) => v.toLocaleString(undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
const join = parts => parts.filter(p => p !== null).join(' · ') || null;
const join2 = parts => parts.filter(p => p !== null).join(' ') || null;
const unit = (v, u, d = 0) => v === null ? null : `${num(v, d)}${u}`;

// A file kept open between reads: lseek+read instead of open/fstat/read/close.
class Handle {
    constructor(path) {
        this._file = Gio.File.new_for_path(path);
        this._stream = null;
    }

    read() {
        try {
            this._stream ??= this._file.read(null);
            this._stream.seek(0, GLib.SeekType.SET, null);
            return dec.decode(this._stream.read_bytes(4096, null).toArray());
        } catch (_e) {
            this.close();
            return null;
        }
    }

    close() {
        try {
            this._stream?.close(null);
        } catch (_e) { /* already gone */ }
        this._stream = null;
    }
}

function findSensors() {
    const s = {cpuTemp: null, fans: [], nvme: []};
    let best = 9;
    for (const h of ls('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${h}`;
        const name = readSync(`${dir}/name`);
        const files = ls(dir);
        if (name === 'nvme' && files.includes('temp1_input'))
            s.nvme.push(`${dir}/temp1_input`);
        if (!GPU_HWMON.includes(name))
            s.fans.push(...files.filter(f => /^fan\d+_input$/.test(f)).map(f => `${dir}/${f}`));
        for (const f of files.filter(x => /^temp\d+_label$/.test(x))) {
            const label = readSync(`${dir}/${f}`) ?? '';
            const rank = name === 'coretemp' && label.startsWith('Package id') ? 0
                : ['k10temp', 'zenpower'].includes(name) && label === 'Tdie' ? 1
                    : ['k10temp', 'zenpower'].includes(name) && label === 'Tctl' ? 2 : 9;
            if (rank < best) {
                best = rank;
                s.cpuTemp = `${dir}/${f.replace('_label', '_input')}`;
            }
        }
        if (best === 9 && name === 'cpu_thermal' && files.includes('temp1_input'))
            s.cpuTemp = `${dir}/temp1_input`;
    }
    s.batteries = ls('/sys/class/power_supply').map(b => `/sys/class/power_supply/${b}`)
        .filter(p => readSync(`${p}/type`) === 'Battery' && readSync(`${p}/scope`) !== 'Device');
    s.policies = ls('/sys/devices/system/cpu/cpufreq').filter(p => p.startsWith('policy'))
        .map(p => `/sys/devices/system/cpu/cpufreq/${p}/scaling_cur_freq`);
    return s;
}

// The discrete GPU: the display controller that is not the boot VGA device,
// or the only one if it is not an Intel iGPU. Reading these attributes never
// resumes a runtime-suspended device.
function findGpu() {
    const gpus = ls('/sys/bus/pci/devices').map(d => `/sys/bus/pci/devices/${d}`)
        .filter(p => (readSync(`${p}/class`) ?? '').startsWith('0x03'));
    const vendor = p => readSync(`${p}/vendor`);
    const pci = gpus.find(p => readSync(`${p}/boot_vga`) === '0') ??
        (gpus.length === 1 && vendor(gpus[0]) !== '0x8086' ? gpus[0] : null);
    if (!pci)
        return null;
    const hw = ls(`${pci}/hwmon`)[0];
    return {pci, nvidia: vendor(pci) === '0x10de', hwmon: hw ? `${pci}/hwmon/${hw}` : null};
}

function productName() {
    const dmi = f => readSync(`/sys/class/dmi/id/${f}`) ?? '';
    // Lenovo stores the model number in product_name and the marketing name in product_version.
    const name = dmi('sys_vendor').toUpperCase() === 'LENOVO' ? dmi('product_version') : dmi('product_name');
    return /^(|to be filled.*|system product name|default string|not applicable|none|o\.?e\.?m\.?)$/i.test(name) ? null : name;
}

export default class LegionStats extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancel = new Gio.Cancellable();
        this._sensors = findSensors();
        this._gpu = findGpu();
        this._stat = new Handle('/proc/stat');
        this._temp = this._sensors.cpuTemp ? new Handle(this._sensors.cpuTemp) : null;
        this._mem = new Handle('/proc/meminfo');
        this._prevStat = null;
        this._cpuPct = null;
        this._blanked = false;
        this._refreshing = false;
        this._nvProc = null;
        this._nvFailed = false;
        this._grab = null;
        this._pinned = false;
        this._gpuBar = null;
        this._gpuBarAt = 0;

        this._button = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._label = new St.Label({text: 'CPU', y_align: Clutter.ActorAlign.CENTER, style_class: 'ls-bar'});
        this._button.add_child(this._label);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
        this._buildCard();

        this._menu = new PopupMenu.PopupMenu(this._button, 0.5, St.Side.TOP);
        this._menu.addAction('Settings', () => this.openPreferences());
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this._button);
        this._menuManager.addMenu(this._menu);

        // Hover shows the card; a click pins it until a click outside or Escape;
        // a right click opens a menu with Settings.
        this._button.connect('notify::hover', () => {
            if (this._button.hover)
                this._showCard();
            else if (!this._pinned)
                this._hideCard();
        });
        this._button.connect('button-press-event', (_a, e) => this._onPress(e.get_button()));
        this._button.connect('touch-event', (_a, e) => e.type() === Clutter.EventType.TOUCH_BEGIN
            ? this._onPress(Clutter.BUTTON_PRIMARY) : Clutter.EVENT_PROPAGATE);
        this._label.connect('notify::mapped', () => this._schedule());
        this._settings.connectObject('changed', () => {
            this._schedule(true);
            if (this._cardTimer)
                this._refreshCard();
        }, this);
        global.backend.get_monitor_manager().connectObject('power-save-mode-changed',
            () => this._updateBlanked(), this);

        this._schedule();
    }

    disable() {
        this._cancel.cancel();
        this._cancel = null;
        global.backend.get_monitor_manager().disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._unpin();
        this._hideCard();
        this._stopBar();
        this._menu.destroy();
        this._menu = this._menuManager = null;
        this._stat.close();
        this._temp?.close();
        this._mem.close();
        this._stat = this._temp = this._mem = null;
        Main.layoutManager.removeChrome(this._card);
        this._card.destroy();
        this._card = this._rows = this._sections = null;
        this._button.destroy();
        this._button = this._label = null;
    }

    // ---- bar ----
    // The bar polls only while it is visible (not in fullscreen, not on a blanked
    // screen). The lock screen needs nothing: without "session-modes" in
    // metadata.json the shell disables the extension while locked.
    _schedule(restart = false) {
        const run = this._label.mapped && !this._blanked;
        if (restart || !run)
            this._stopBar();
        if (!run || this._barTimer)
            return;
        this._tick();
        this._barTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW,
            this._settings.get_int('bar-interval'), () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopBar() {
        if (this._barTimer)
            GLib.source_remove(this._barTimer);
        this._barTimer = null;
        this._prevStat = null;
    }

    async _updateBlanked() {
        try {
            const [v] = (await Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig', 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.gnome.Mutter.DisplayConfig', 'PowerSaveMode']),
                null, Gio.DBusCallFlags.NONE, -1, this._cancel)).deepUnpack();
            this._blanked = v.deepUnpack() !== 0;
            this._schedule();
        } catch (_e) { /* cancelled or no mutter */ }
    }

    // Busy share of the aggregate "cpu" line. guest/guest_nice (fields 9-10) are
    // already counted in user/nice, so they are left out; steal counts as busy,
    // as in top. Counters are 64-bit; a non-increasing total is skipped.
    _cpuUsage() {
        const f = (this._stat.read() ?? '').split('\n')[0].split(/\s+/).slice(1, 9).map(Number);
        if (f.length < 4 || f.some(Number.isNaN))
            return null;
        const idle = f[3] + (f[4] ?? 0);
        const total = f.reduce((a, b) => a + b, 0);
        const prev = this._prevStat;
        this._prevStat = {idle, total};
        if (!prev || total <= prev.total)
            return null;
        return Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total))));
    }

    _cpuTemp() {
        const v = toNum(this._temp?.read()?.trim() ?? null);
        return v === null ? null : v / 1000;
    }

    // Memory in use as in free/htop: MemTotal - MemAvailable.
    _memPct() {
        const t = this._mem.read() ?? '';
        const total = Number(t.match(/^MemTotal:\s+(\d+)/m)?.[1]);
        const avail = Number(t.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
        return total && !Number.isNaN(avail) ? 100 * (1 - avail / total) : null;
    }

    _tick() {
        const on = k => this._settings.get_boolean(`bar-${k}`);
        this._cpuPct = this._cpuUsage() ?? this._cpuPct;
        const cpu = join2([
            on('cpu-usage') ? this._cpuPct === null ? '…' : `${num(this._cpuPct)}%` : null,
            on('cpu-temp') ? unit(this._cpuTemp(), '°') : null,
        ]);
        let gpu = null;
        if (this._gpu && (on('gpu-usage') || on('gpu-temp'))) {
            if (GLib.get_monotonic_time() - this._gpuBarAt >= GPU_BAR_INTERVAL_US)
                this._readGpuBar();
            const g = this._gpuBar;
            gpu = g === 'off' ? 'off' : join2([
                on('gpu-usage') ? unit(g?.usage ?? null, '%') : null,
                on('gpu-temp') ? unit(g?.temp ?? null, '°') : null,
            ]);
        }
        const mem = on('memory') ? unit(this._memPct(), '%') : null;
        this._label.set_text(join([
            cpu && `CPU ${cpu}`, gpu && `GPU ${gpu}`, mem && `RAM ${mem}`,
        ].map(x => x || null)) ?? 'CPU');
    }

    // GPU usage and temperature for the bar, under the same never-wake rule as
    // the card, and at most every GPU_BAR_INTERVAL_US.
    async _readGpuBar() {
        const g = this._gpu;
        const c = this._cancel;
        this._gpuBarAt = GLib.get_monotonic_time();
        const rt = await read(`${g.pci}/power/runtime_status`, c);
        if (rt !== null && rt !== 'active') {
            this._gpuBar = 'off';
            return;
        }
        if (this._nvProc)
            return; // the open card's nvidia-smi loop already updates it
        let bar = null;
        if (g.nvidia && !this._nvFailed && readSync(`${g.pci}/power/runtime_status`) === 'active') {
            try {
                const proc = Gio.Subprocess.new(['nvidia-smi', '-i', g.pci.split('/').pop(),
                    '--query-gpu=utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                const [out] = await proc.communicate_utf8_async(null, c);
                const [usage, temp] = (out ?? '').split(',').map(x => toNum(x.trim()));
                bar = {usage, temp};
            } catch (_e) { /* no nvidia-smi, or cancelled */ }
        } else if (!g.nvidia) {
            const [usage, temp] = await Promise.all([
                read(`${g.pci}/gpu_busy_percent`, c).then(toNum),
                g.hwmon ? read(`${g.hwmon}/temp1_input`, c).then(toNum) : null,
            ]);
            bar = {usage, temp: temp === null ? null : temp / 1000};
        }
        if (!c.is_cancelled())
            this._gpuBar = bar;
    }

    // ---- card ----
    _row(section, key) {
        const row = new St.BoxLayout({x_expand: true, visible: false});
        const k = new St.Label({text: key, style_class: 'ls-key', x_expand: true, opacity: 180});
        const v = new St.Label({style_class: 'ls-val', x_align: Clutter.ActorAlign.END});
        row.add_child(k);
        row.add_child(v);
        this._card.add_child(row);
        section.rows.push(row);
        return {row, v};
    }

    _section(key, title) {
        const label = title ? new St.Label({text: title, style_class: 'ls-section', opacity: 200}) : null;
        if (label)
            this._card.add_child(label);
        return (this._sections[key] = {label, rows: []});
    }

    _buildCard() {
        this._card = new St.BoxLayout({vertical: true, style_class: 'popup-menu-content ls-card', visible: false, reactive: true});
        this._card.connect('captured-event', (_a, e) => this._onCardEvent(e));
        // -st-accent-color exists from GNOME 47; only opt in where the theme knows it.
        if (St.Settings.get().accent_color !== undefined)
            this._card.add_style_class_name('ls-accent');
        const title = productName();
        if (title)
            this._card.add_child(new St.Label({text: title, style_class: 'ls-title'}));

        this._sections = {};
        const r = this._rows = {};
        let s = this._section('top', null);
        r.profile = this._row(s, 'Platform profile');

        s = this._section('cpu', 'CPU');
        r.cpuLoad = this._row(s, 'Usage');
        r.cpuFt = this._row(s, 'Frequency / temp');

        s = this._section('gpu', 'GPU');
        r.gpuState = this._row(s, 'State');
        r.gpuLoad = this._row(s, 'Usage / VRAM');
        r.gpuFt = this._row(s, 'Clock / temp');
        r.gpuPower = this._row(s, 'Power / P-state');
        r.gpuFan = this._row(s, 'Fan');

        s = this._section('system', 'SYSTEM');
        r.fans = this._row(s, 'Fans');
        r.ram = this._row(s, 'Memory');
        r.ssd = this._row(s, 'SSD temp');
        r.bat = this._row(s, 'Battery');

        Main.layoutManager.addTopChrome(this._card);
    }

    _set(row, text) {
        row.v.text = text ?? '';
        row.row.visible = text !== null;
    }

    _onPress(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this._unpin();
            this._hideCard();
            this._menu.toggle();
        } else
            this._pin();
        return Clutter.EVENT_STOP;
    }

    _pin() {
        if (this._pinned)
            return;
        // Set first: the grab drops the button's hover, which must not hide the card.
        this._pinned = true;
        this._showCard();
        // A grab on a hidden actor is cancelled, so show it before the first refresh lands.
        this._card.show();
        this._placeCard();
        this._grab = Main.pushModal(this._card, {actionMode: Shell.ActionMode.POPUP});
        this._card.grab_key_focus();
    }

    _unpin() {
        if (!this._pinned)
            return;
        this._pinned = false;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        if (!this._button.hover)
            this._hideCard();
    }

    // While the card holds the grab every event targets it, so test the position.
    _contains(x, y) {
        const [cx, cy] = this._card.get_transformed_position();
        const [w, h] = this._card.get_transformed_size();
        return x >= cx && x < cx + w && y >= cy && y < cy + h;
    }

    // Same rules as the shell's popup menus: Escape or a press outside closes.
    _onCardEvent(event) {
        if (!this._pinned)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._unpin();
            return Clutter.EVENT_STOP;
        }
        if ((type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) &&
            !this._contains(...event.get_coords())) {
            this._unpin();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _showCard() {
        if (this._cardTimer)
            return;
        this._refreshCard();
        this._cardTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, CARD_INTERVAL_S, () => {
            this._refreshCard();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _hideCard() {
        if (this._cardTimer)
            GLib.source_remove(this._cardTimer);
        this._cardTimer = null;
        this._stopNvidia();
        this._card.hide();
    }

    _placeCard() {
        const [bx, by] = this._button.get_transformed_position();
        const [bw, bh] = this._button.get_size();
        const mon = Main.layoutManager.findMonitorForActor(this._button) ?? Main.layoutManager.primaryMonitor;
        const [, cw] = this._card.get_preferred_width(-1);
        const [, ch] = this._card.get_preferred_height(cw);
        const gap = 6;
        const x = Math.max(mon.x + gap, Math.min(Math.round(bx + bw / 2 - cw / 2), mon.x + mon.width - cw - gap));
        // Below the button, or above it when the panel sits at the bottom.
        const y = by + bh / 2 > mon.y + mon.height / 2 ? by - ch - gap : by + bh + gap;
        this._card.set_position(x, Math.round(y));
    }

    async _refreshCard() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        const c = this._cancel;
        const on = k => this._settings.get_boolean(`show-${k}`);
        try {
            const [profile, cpu, sys] = await Promise.all([
                read('/sys/firmware/acpi/platform_profile', c),
                on('cpu') ? this._readCpu(c) : null,
                on('system') ? this._readSystem(c) : null,
                on('gpu') ? this._refreshGpu(c) : this._noGpu(),
            ]);
            if (c.is_cancelled() || !this._cardTimer)
                return;
            const r = this._rows;
            this._set(r.profile, profile ? profile.charAt(0).toUpperCase() + profile.slice(1).replace(/-/g, ' ') : null);
            for (const [k, v] of Object.entries({...cpu ?? {cpuLoad: null, cpuFt: null}, ...sys ?? {fans: null, ram: null, ssd: null, bat: null}}))
                this._set(r[k], v);
            for (const {label, rows} of Object.values(this._sections)) {
                if (label)
                    label.visible = rows.some(row => row.visible);
            }
            this._card.show();
            this._placeCard();
        } catch (e) {
            console.error(`${this.metadata.name}: ${e}`);
        } finally {
            this._refreshing = false;
        }
    }

    async _readCpu(c) {
        // x86 /proc/cpuinfo reports every online CPU from tick-sampled APERF/MPERF
        // in one read; elsewhere fall back to the online cpufreq policies.
        const info = await read('/proc/cpuinfo', c);
        let mhz = [...(info ?? '').matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map(m => Number(m[1]));
        if (!mhz.length) {
            mhz = (await Promise.all(this._sensors.policies.map(p => read(p, c))))
                .map(toNum).filter(v => v).map(v => v / 1000);
        }
        const ghz = mhz.length ? mhz.reduce((a, b) => a + b) / mhz.length / 1000 : null;
        return {
            cpuLoad: unit(this._cpuPct, '%'),
            cpuFt: join([unit(ghz, ' GHz', 1), unit(this._cpuTemp(), ' °C')]),
        };
    }

    async _readSystem(c) {
        const nums = paths => Promise.all(paths.map(p => read(p, c).then(toNum)));
        const s = this._sensors;
        const [fans, nvme, meminfo, bats] = await Promise.all([
            nums(s.fans),
            nums(s.nvme),
            read('/proc/meminfo', c),
            Promise.all(s.batteries.map(async b => {
                const [cap, status, pw, cur, volt] = await Promise.all(
                    ['capacity', 'status', 'power_now', 'current_now', 'voltage_now'].map(f => read(`${b}/${f}`, c)));
                // power_now is µW; some drivers only give current (µA) and voltage (µV)
                // and some report discharge as negative.
                const watts = toNum(pw) !== null ? Math.abs(toNum(pw)) / 1e6
                    : toNum(cur) !== null && toNum(volt) !== null ? Math.abs(toNum(cur) * toNum(volt)) / 1e12 : null;
                return {cap: toNum(cap), status, watts};
            })),
        ]);

        const spinning = fans.filter(v => v !== null && v > 0);
        const mi = Object.fromEntries((meminfo ?? '').split('\n')
            .map(l => l.match(/^(\w+):\s+(\d+)/)).filter(m => m).map(m => [m[1], Number(m[2]) * 1024]));
        const temps = nvme.filter(v => v !== null).map(v => num(v / 1000));
        const caps = bats.map(b => b.cap).filter(v => v !== null);
        const watts = bats.reduce((a, b) => a + (b.watts ?? 0), 0);
        const status = bats.find(b => b.status)?.status ?? null;

        return {
            fans: !fans.some(v => v !== null) ? null
                : spinning.length ? `${spinning.map(v => num(v)).join(' · ')} RPM` : 'Stopped',
            ram: mi.MemTotal && mi.MemAvailable !== undefined
                ? `${GLib.format_size(mi.MemTotal - mi.MemAvailable)} / ${GLib.format_size(mi.MemTotal)}` +
                  ` · ${num(100 * (1 - mi.MemAvailable / mi.MemTotal))}%`
                : null,
            ssd: temps.length ? `${temps.join(' · ')} °C` : null,
            bat: caps.length ? join([
                `${num(caps.reduce((a, b) => a + b) / caps.length)}%`, status,
                /^(Charging|Discharging)$/.test(status) && watts > 0.05 ? unit(watts, ' W', 1) : null,
            ]) : null,
        };
    }

    // ---- gpu ----
    // The dGPU is only queried while its runtime PM status is "active". The
    // check is re-done right before nvidia-smi starts, but userspace cannot make
    // it atomic: if the GPU suspends in that window of a few ms, nvidia-smi
    // resumes it. While the card stays open the running nvidia-smi holds the
    // device, so an already-active GPU cannot suspend until the card closes.
    _noGpu() {
        for (const k of ['gpuState', 'gpuLoad', 'gpuFt', 'gpuPower', 'gpuFan'])
            this._set(this._rows[k], null);
        this._stopNvidia();
    }

    async _refreshGpu(c) {
        const g = this._gpu;
        if (!g)
            return this._noGpu();
        const rt = await read(`${g.pci}/power/runtime_status`, c);
        const active = rt === 'active' || rt === null;
        this._set(this._rows.gpuState, rt === 'suspended' ? 'Off (suspended)' : rt ? rt.charAt(0).toUpperCase() + rt.slice(1) : null);
        if (!active) {
            for (const k of ['gpuLoad', 'gpuFt', 'gpuPower', 'gpuFan'])
                this._set(this._rows[k], null);
            return this._stopNvidia();
        }
        if (g.nvidia)
            return this._startNvidia();
        // amdgpu exposes load and VRAM on the PCI device; amdgpu, i915 and xe
        // expose temperature, power, clock and fan through their hwmon.
        const dev = f => read(`${g.pci}/${f}`, c).then(toNum);
        const hw = f => g.hwmon ? read(`${g.hwmon}/${f}`, c).then(toNum) : null;
        const [busy, vu, vt, temp, pavg, pin, freq, fan] = await Promise.all([
            dev('gpu_busy_percent'), dev('mem_info_vram_used'), dev('mem_info_vram_total'),
            hw('temp1_input'), hw('power1_average'), hw('power1_input'), hw('freq1_input'), hw('fan1_input'),
        ]);
        if (c.is_cancelled())
            return null;
        const watts = pavg ?? pin;
        this._set(this._rows.gpuLoad, join([unit(busy, '%'),
            vu !== null && vt ? `${GLib.format_size(vu)} / ${GLib.format_size(vt)}` : null]));
        this._set(this._rows.gpuFt, join([unit(freq === null ? null : freq / 1e6, ' MHz'), unit(temp === null ? null : temp / 1000, ' °C')]));
        this._gpuBar = {usage: busy, temp: temp === null ? null : temp / 1000};
        this._set(this._rows.gpuPower, unit(watts === null ? null : watts / 1e6, ' W', 1));
        this._set(this._rows.gpuFan, unit(fan, ' RPM'));
        return null;
    }

    _startNvidia() {
        if (this._nvProc || this._nvFailed)
            return;
        // Re-check as late as possible (see the comment above).
        if (readSync(`${this._gpu.pci}/power/runtime_status`) !== 'active')
            return;
        let proc;
        try {
            proc = Gio.Subprocess.new(['nvidia-smi', '-i', this._gpu.pci.split('/').pop(),
                `--query-gpu=${NV_FIELDS}`, '--format=csv,noheader,nounits', '-lms', `${CARD_INTERVAL_S * 1000}`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_e) {
            this._nvFailed = true; // no nvidia-smi installed
            return;
        }
        this._nvProc = proc;
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        const c = this._cancel;
        (async () => {
            for (;;) {
                const [line] = await stream.read_line_async(GLib.PRIORITY_LOW, c);
                if (line === null || c.is_cancelled())
                    break;
                this._nvidiaLine(dec.decode(line));
            }
        })().catch(() => {}).finally(() => {
            if (this._nvProc === proc)
                this._nvProc = null;
            proc.force_exit();
        });
    }

    _stopNvidia() {
        this._nvProc?.force_exit();
        this._nvProc = null;
        return null;
    }

    _nvidiaLine(line) {
        if (!this._rows || !this._cardTimer)
            return;
        // Unsupported fields read "[N/A]" or "[Not Supported]" and are hidden.
        const [util, mu, mt, clk, tmp, pwr, ps] = line.split(',').map(s => s.trim());
        const mib = x => toNum(x) === null ? null : GLib.format_size(toNum(x) * 1048576);
        this._set(this._rows.gpuLoad, join([unit(toNum(util), '%'), mib(mu) && mib(mt) ? `${mib(mu)} / ${mib(mt)}` : null]));
        this._set(this._rows.gpuFt, join([unit(toNum(clk), ' MHz'), unit(toNum(tmp), ' °C')]));
        this._gpuBar = {usage: toNum(util), temp: toNum(tmp)};
        this._set(this._rows.gpuPower, join([unit(toNum(pwr), ' W', 1), /^P\d+$/.test(ps ?? '') ? ps : null]));
        this._set(this._rows.gpuFan, null);
    }
}
