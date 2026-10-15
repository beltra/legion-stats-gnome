import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LegionStatsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({description: 'The hover card refreshes every 2 seconds while open.'});
        page.add(group);

        const interval = Adw.SpinRow.new_with_range(1, 10, 1);
        interval.title = 'Top bar interval (seconds)';
        settings.bind('bar-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        for (const [key, title] of [['show-cpu', 'CPU section'], ['show-gpu', 'GPU section'], ['show-system', 'System section']]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        window.add(page);
    }
}
