import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { THEMES, THEME_ORDER, DEFAULT_THEME } from "./themes.js";

const ALIGNMENTS = [
  ["auto", "Automatic (follow theme)"],
  ["left", "Left"],
  ["right", "Right"],
];

export default class GNetUtilityPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    // Keep a reference so the settings object outlives this call.
    window._gnetUtilitySettings = settings;
    window.set_default_size(560, 720);

    window.add(this._appearancePage(settings));
    window.add(this._rowsPage(settings));
    window.add(this._behaviourPage(settings));
  }

  // ---------- helpers ----------

  _switchRow(settings, key, title, subtitle = "") {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _spinRow(settings, key, title, subtitle, min, max, step) {
    const row = new Adw.SpinRow({
      title,
      subtitle,
      adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step, page_increment: step * 5 }),
    });
    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // Combo bound to a string key. options: [[id, label], ...]
  _comboRow(settings, key, title, subtitle, options, fallbackId) {
    const row = new Adw.ComboRow({
      title,
      subtitle,
      model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const idToIndex = (id) => {
      const i = options.findIndex(([v]) => v === id);
      return i >= 0 ? i : options.findIndex(([v]) => v === fallbackId);
    };
    row.set_selected(idToIndex(settings.get_string(key)));
    row.connect("notify::selected", () => {
      const id = options[row.get_selected()]?.[0];
      if (id && id !== settings.get_string(key)) settings.set_string(key, id);
    });
    settings.connect(`changed::${key}`, () => {
      const i = idToIndex(settings.get_string(key));
      if (i !== row.get_selected()) row.set_selected(i);
    });
    return row;
  }

  // ---------- pages ----------

  _appearancePage(settings) {
    const page = new Adw.PreferencesPage({ title: "Appearance", icon_name: "applications-graphics-symbolic" });

    const look = new Adw.PreferencesGroup({ title: "Look" });
    look.add(
      this._comboRow(
        settings,
        "theme",
        "Theme",
        "Colours and card style",
        THEME_ORDER.map((id) => [id, `${THEMES[id].name} — ${THEMES[id].desc}`]),
        DEFAULT_THEME,
      ),
    );
    look.add(this._comboRow(settings, "alignment", "Alignment", "Which side the text hugs", ALIGNMENTS, "auto"));
    look.add(this._spinRow(settings, "corner-radius", "Corner radius", "Pixels; 0 = square (no effect on Bare Text)", 0, 40, 1));
    look.add(this._switchRow(settings, "card-border", "Card border", "Thin outline around the card"));
    look.add(this._switchRow(settings, "card-shadow", "Card shadow", "Drop shadow behind the card"));
    look.add(this._switchRow(settings, "text-shadow", "Text shadow", "Soft dark shadow behind text; helps on bright wallpapers"));
    look.add(this._switchRow(settings, "show-header", "Show title and status dot"));
    page.add(look);

    const size = new Adw.PreferencesGroup({ title: "Size" });
    size.add(this._spinRow(settings, "widget-width", "Width", "Pixels", 240, 520, 10));
    size.add(this._spinRow(settings, "font-scale", "Font size", "Percent of default", 70, 160, 5));
    size.add(
      this._spinRow(
        settings,
        "background-strength",
        "Card opacity",
        "Percent of the theme's default (no effect on Bare Text)",
        0,
        150,
        5,
      ),
    );
    page.add(size);
    return page;
  }

  _rowsPage(settings) {
    const page = new Adw.PreferencesPage({ title: "Rows", icon_name: "view-list-symbolic" });

    const net = new Adw.PreferencesGroup({ title: "Local network" });
    net.add(this._switchRow(settings, "show-wifi", "Wi-Fi / Ethernet"));
    net.add(this._switchRow(settings, "show-link", "Link speed"));
    net.add(this._switchRow(settings, "show-local-ip", "Local IP", "Includes Automatic / Manual"));
    net.add(this._switchRow(settings, "show-gateway", "Gateway"));
    page.add(net);

    const pub = new Adw.PreferencesGroup({ title: "Public" });
    pub.add(this._switchRow(settings, "show-public-ip", "Public IP"));
    pub.add(this._switchRow(settings, "show-location", "Approximate location"));
    page.add(pub);

    const tun = new Adw.PreferencesGroup({ title: "Proxy and VPN" });
    tun.add(this._switchRow(settings, "show-proxy", "Proxy"));
    tun.add(this._switchRow(settings, "show-vpn", "VPN"));
    tun.add(
      this._switchRow(settings, "show-tailscale", "Tailscale details", "Profile, Tailscale IP and exit node (only while connected)"),
    );
    page.add(tun);
    return page;
  }

  _behaviourPage(settings) {
    const page = new Adw.PreferencesPage({ title: "Behaviour", icon_name: "preferences-system-symbolic" });

    const interact = new Adw.PreferencesGroup({ title: "Interaction" });
    interact.add(this._switchRow(settings, "click-to-copy", "Click to copy", "Left-click an IP or name to copy it"));
    interact.add(this._switchRow(settings, "lock-position", "Lock position", "Disable dragging"));

    const reset = new Adw.ActionRow({ title: "Reset position", subtitle: "Move the widget back to its default spot" });
    const btn = new Gtk.Button({ label: "Reset", valign: Gtk.Align.CENTER });
    btn.connect("clicked", () => {
      settings.reset("x-percent");
      settings.reset("y-percent");
    });
    reset.add_suffix(btn);
    interact.add(reset);
    page.add(interact);

    const data = new Adw.PreferencesGroup({
      title: "Data",
      description: "Only the public IP lookup uses the internet (one tiny request). Everything else is read locally.",
    });
    data.add(
      this._switchRow(
        settings,
        "lookup-public-ip",
        "Look up public IP and location",
        "Sends one request to ipinfo.io (fallback ip-api.com). Turn off to stay fully offline.",
      ),
    );
    data.add(this._spinRow(settings, "local-refresh-seconds", "Local refresh", "Seconds between checks of Wi-Fi, IP, proxy, VPN", 10, 600, 5));
    data.add(this._spinRow(settings, "remote-refresh-minutes", "Public IP refresh", "Minutes between lookups", 1, 120, 1));
    page.add(data);
    return page;
  }
}
