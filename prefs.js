import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LegionStatsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        const group = new Adw.PreferencesGroup({title: 'Card', description: 'The card refreshes every 2 seconds while open.'});
        page.add(group);

        const interval = Adw.SpinRow.new_with_range(1, 10, 1);
        interval.title = 'Top bar interval (seconds)';
        settings.bind('bar-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        bar.add(interval);
        const gpuNote = 'Read every 10 seconds, and only while the discrete GPU is already awake';
        for (const [key, title, subtitle] of [
            ['bar-cpu-usage', 'CPU usage'], ['bar-cpu-temp', 'CPU temperature'],
            ['bar-gpu-usage', 'GPU usage', gpuNote], ['bar-gpu-temp', 'GPU temperature', gpuNote],
            ['bar-memory', 'Memory usage'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            bar.add(row);
        }

        for (const [key, title] of [['show-cpu', 'CPU section'], ['show-gpu', 'GPU section'], ['show-system', 'System section']]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        window.add(page);
    }
}
