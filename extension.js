import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Pango from "gi://Pango";
import Soup from "gi://Soup";

import { THEMES, THEME_ORDER, DEFAULT_THEME } from "./themes.js";

const TAG = "[gnet-utility]";
const EDGE_PADDING_PX = 30;
const NETWORK_CHANGE_DEBOUNCE_MS = 2000;
const REBUILD_DEBOUNCE_MS = 80;
const REBUILD_AFTER_MENU_MS = 450; // let the menu's close animation finish before destroying it
const COPY_FLASH_MS = 1100;
const CLICK_MOVE_THRESHOLD_PX = 4;
const IP_LOOKUP_URLS = ["https://ipinfo.io/json", "http://ip-api.com/json"];
const VPN_IFACE_RE = /^(wg|tun|tap|ppp|nordlynx|proton|mullvad|ipsec|vpn|zt)/i;
const POSITION_KEYS = ["x-percent", "y-percent"];

const IP4_METHOD_LABELS = {
  auto: "Automatic",
  manual: "Manual",
  "link-local": "Link-local",
  shared: "Shared",
  disabled: "Disabled",
};

const C_WARN = "#fbbf24";
const C_BAD = "#f87171";

// key, caption, settings key, section, options
const ROW_DEFS = [
  { key: "wifi", caption: "Wi-Fi", pref: "show-wifi", group: 0, copy: true },
  { key: "link", caption: "Link", pref: "show-link", group: 0 },
  { key: "ip", caption: "Local IP", pref: "show-local-ip", group: 0, copy: true, secondary: true },
  { key: "gateway", caption: "Gateway", pref: "show-gateway", group: 0, copy: true },
  { key: "public", caption: "Public IP", pref: "show-public-ip", group: 1, copy: true },
  { key: "location", caption: "Location", pref: "show-location", group: 1, secondary: true },
  { key: "proxy", caption: "Proxy", pref: "show-proxy", group: 2, dot: true },
  { key: "vpn", caption: "VPN", pref: "show-vpn", group: 2, dot: true },
  { key: "tsProfile", caption: "Profile", pref: "show-tailscale", group: 2, dataHidden: true },
  { key: "tsIp", caption: "Tailscale", pref: "show-tailscale", group: 2, copy: true, dataHidden: true },
  { key: "tsExit", caption: "Exit node", pref: "show-tailscale", group: 2, dataHidden: true },
];
const GROUP_COUNT = 3;

const COMMAND_TIMEOUT_SECONDS = 8;

// Wrap a callback so an exception can never escape into the shell's main loop.
function safe(fn, fallback = undefined) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      console.error(`${TAG} ${e}`);
      return fallback;
    }
  };
}

// Run a command asynchronously; resolves to trimmed stdout, or null on failure/timeout.
function run(argv, cancellable) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutId) GLib.source_remove(timeoutId);
      resolve(value);
    };
    try {
      const proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
      // A hung command must never wedge the widget.
      timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COMMAND_TIMEOUT_SECONDS, () => {
        timeoutId = 0;
        try {
          proc.force_exit();
        } catch (_e) {
          // already gone
        }
        finish(null);
        return GLib.SOURCE_REMOVE;
      });
      proc.communicate_utf8_async(null, cancellable, (p, res) => {
        try {
          const [, out] = p.communicate_utf8_finish(res);
          finish(p.get_successful() ? (out ?? "").trim() : null);
        } catch (_e) {
          finish(null);
        }
      });
    } catch (_e) {
      finish(null);
    }
  });
}

export default class GNetUtilityExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._settings = null;
    this._settingsChangedId = null;
    this._container = null;
    this._statusDot = null;
    this._rows = {};
    this._dividers = [];
    this._state = {}; // key -> last known content, replayed after every rebuild
    this._menu = null;
    this._menuManager = null;
    this._themeItems = {};
    this._menuBusy = false;
    this._grab = null;
    this._dragging = false;
    this._pressX = 0;
    this._pressY = 0;
    this._dragOffsetX = 0;
    this._dragOffsetY = 0;
    this._cancellable = null;
    this._httpSession = null;
    this._localTimeoutId = null;
    this._remoteTimeoutId = null;
    this._debounceId = null;
    this._rebuildId = null;
    this._repositionId = null;
    this._closeIdleId = null;
    this._flashIds = new Set();
    this._monitorChangedId = null;
    this._networkMonitor = null;
    this._networkChangedId = null;
    this._localBusy = false;
    this._remoteBusy = false;
    this._hasLink = false;
    this._publicOk = null;
    this._theme = THEMES[DEFAULT_THEME];
  }

  // ---------- settings ----------

  _bool(key) {
    return this._settings ? this._settings.get_boolean(key) : true;
  }

  _int(key) {
    return this._settings.get_int(key);
  }

  // Read a key that may not exist in an older compiled schema without ever aborting the shell.
  _opt(key, fallback) {
    const schema = this._settings?.settings_schema;
    if (!schema?.has_key(key)) return fallback;
    const type = schema.get_key(key).get_value_type().dup_string();
    return type === "b" ? this._settings.get_boolean(key) : this._settings.get_int(key);
  }

  _readTheme() {
    const id = this._settings.get_string("theme");
    this._theme = THEMES[id] ?? THEMES[DEFAULT_THEME];
  }

  _align() {
    const a = this._settings.get_string("alignment");
    return a === "left" || a === "right" ? a : this._theme.defaultAlign;
  }

  _fs(px) {
    return Math.max(8, Math.round((px * this._int("font-scale")) / 100));
  }

  _onSettingChanged(key) {
    if (POSITION_KEYS.includes(key)) {
      // Ignore our own saves; react only to a reset (-1).
      if (this._settings.get_double(key) < 0) this._schedulePosition();
      return;
    }
    if (key === "local-refresh-seconds" || key === "remote-refresh-minutes") {
      this._scheduleTimers();
      return;
    }
    if (key === "lookup-public-ip") {
      this._scheduleRebuild(() => this._refreshRemote());
      return;
    }
    this._scheduleRebuild();
  }

  _scheduleRebuild(after = null, delay = null) {
    if (this._rebuildId) GLib.source_remove(this._rebuildId);
    // If the menu is involved, never destroy it mid-animation.
    const wait = delay ?? (this._menu?.isOpen || this._menuBusy ? REBUILD_AFTER_MENU_MS : REBUILD_DEBOUNCE_MS);
    this._rebuildId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      wait,
      safe(() => {
        this._rebuildId = null;
        if (this._menu?.isOpen) {
          // Still open (e.g. changed from the Settings window): close it, then retry.
          this._menu.close();
          this._scheduleRebuild(after, REBUILD_AFTER_MENU_MS);
          return GLib.SOURCE_REMOVE;
        }
        this._menuBusy = false;
        this._rebuild();
        if (after) after();
        return GLib.SOURCE_REMOVE;
      }, GLib.SOURCE_REMOVE),
    );
  }

  _schedulePosition() {
    if (this._repositionId) GLib.source_remove(this._repositionId);
    this._repositionId = GLib.idle_add(
      GLib.PRIORITY_DEFAULT_IDLE,
      safe(() => {
        this._repositionId = null;
        this._positionWidget();
        return GLib.SOURCE_REMOVE;
      }, GLib.SOURCE_REMOVE),
    );
  }

  _savePosition() {
    if (!this._container || !this._settings) return;
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const [x, y] = this._container.get_position();
    this._settings.set_double("x-percent", Math.max(0, (x - monitor.x) / monitor.width));
    this._settings.set_double("y-percent", Math.max(0, (y - monitor.y) / monitor.height));
  }

  // ---------- lifecycle ----------

  enable() {
    try {
      this._enable();
    } catch (e) {
      // Never take the shell down with us: undo whatever got built and stay inert.
      console.error(`${TAG} enable failed: ${e}`);
      try {
        this.disable();
      } catch (e2) {
        console.error(`${TAG} cleanup failed: ${e2}`);
      }
    }
  }

  _enable() {
    this._cancellable = new Gio.Cancellable();
    this._settings = this.getSettings();
    this._settingsChangedId = this._settings.connect(
      "changed",
      safe((_s, key) => this._onSettingChanged(key)),
    );

    this._build();
    this._positionWidget();
    this._schedulePosition(); // again once the actor has a real size

    this._monitorChangedId = Main.layoutManager.connect(
      "monitors-changed",
      safe(() => this._positionWidget()),
    );

    this._networkMonitor = Gio.NetworkMonitor.get_default();
    this._networkChangedId = this._networkMonitor.connect(
      "network-changed",
      safe(() => this._scheduleDebouncedRefresh()),
    );

    this._scheduleTimers();
    this._refreshAll();
  }

  _scheduleTimers() {
    for (const id of ["_localTimeoutId", "_remoteTimeoutId"]) {
      if (this[id]) {
        GLib.source_remove(this[id]);
        this[id] = null;
      }
    }
    if (!this._settings) return;
    this._localTimeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      this._int("local-refresh-seconds"),
      safe(() => {
        this._refreshLocal();
        return GLib.SOURCE_CONTINUE;
      }, GLib.SOURCE_CONTINUE),
    );
    this._remoteTimeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      this._int("remote-refresh-minutes") * 60,
      safe(() => {
        this._refreshRemote();
        return GLib.SOURCE_CONTINUE;
      }, GLib.SOURCE_CONTINUE),
    );
  }

  _closeWidget() {
    // "Kill" = a clean disable of this extension. Deferred so we aren't
    // destroying the actor from inside its own menu handler.
    if (this._closeIdleId) return;
    this._closeIdleId = GLib.idle_add(
      GLib.PRIORITY_DEFAULT_IDLE,
      safe(() => {
        this._closeIdleId = null;
        try {
          Main.extensionManager.disableExtension(this.uuid);
        } catch (e) {
          console.error(`${TAG} close failed: ${e}`);
          this.disable();
        }
        return GLib.SOURCE_REMOVE;
      }, GLib.SOURCE_REMOVE),
    );
  }

  // ---------- UI build ----------

  _teardownUI() {
    this._endDrag();
    for (const id of this._flashIds) GLib.source_remove(id);
    this._flashIds.clear();
    if (this._menu) {
      this._menu.destroy();
      this._menu = null;
    }
    this._menuManager = null;
    this._themeItems = {};
    this._menuBusy = false;
    if (this._container) {
      this._container.destroy();
      this._container = null;
    }
    this._statusDot = null;
    this._rows = {};
    this._dividers = [];
  }

  _rebuild() {
    if (!this._settings) return;
    this._teardownUI();
    this._build();
    this._positionWidget();
    this._schedulePosition();
    this._setStatusDot();
  }

  _build() {
    this._readTheme();
    const t = this._theme;
    const align = this._align();
    const card = t.card;
    const strength = this._int("background-strength") / 100;

    let style;
    if (card) {
      const a = Math.min(1, card.alpha * strength).toFixed(3);
      style = `
        background-color: rgba(${card.rgb.join(", ")}, ${a});
        border: ${this._opt("card-border", true) ? `1px solid ${card.border}` : "none"};
        border-radius: ${this._opt("corner-radius", 0)}px;
        padding: 14px 18px 16px 18px;
        ${this._opt("card-shadow", false) ? "box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);" : ""}
        spacing: 11px;`;
    } else {
      style = "padding: 6px 4px; spacing: 11px;";
    }
    if (t.font) style += ` font-family: ${t.font};`;

    this._container = new St.BoxLayout({
      vertical: true,
      reactive: true,
      track_hover: true,
      width: this._int("widget-width"),
      style,
    });

    if (this._bool("show-header")) this._container.add_child(this._buildHeader(align));

    // Rows grouped into sections with dividers between non-empty ones.
    let group = -1;
    for (const def of ROW_DEFS) {
      if (def.group !== group) {
        if (group >= 0) this._dividers.push(this._addDivider());
        group = def.group;
      }
      this._addRow(def, align);
    }

    this._buildMenu();
    this._connectDragHandlers();

    const bg = Main.layoutManager._backgroundGroup;
    if (!bg) throw new Error("background group unavailable on this shell version");
    bg.add_child(this._container);

    this._replayState();
    this._applyVisibility();
  }

  _shadow() {
    // Off by default; opt-in from Settings. has_key guards against an older compiled schema.
    return this._opt("text-shadow", false) ? "text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);" : "";
  }

  _buildHeader(align) {
    const t = this._theme;
    const header = new St.BoxLayout({ vertical: false, style: "spacing: 8px;" });
    const title = new St.Label({
      text: "NETWORK",
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: align === "left",
      style: `color: ${t.dim}; font-size: ${this._fs(10)}px; font-weight: bold; letter-spacing: 2.4px; ${this._shadow()}`,
    });
    this._statusDot = new St.Label({
      text: "●",
      y_align: Clutter.ActorAlign.CENTER,
      style: `color: ${t.off}; font-size: ${this._fs(10)}px;`,
    });
    if (align === "right") {
      header.add_child(new St.Widget({ x_expand: true }));
    }
    header.add_child(title);
    header.add_child(this._statusDot);
    return header;
  }

  _addDivider() {
    const d = new St.Widget({
      height: 1,
      x_expand: true,
      style: `background-color: ${this._theme.divider};`,
    });
    this._container.add_child(d);
    return d;
  }

  _dotGlyph(on) {
    return this._theme.hollowOff && !on ? "○" : "●";
  }

  _addRow(def, align) {
    const t = this._theme;
    const right = align === "right";
    const sh = this._shadow();
    const actor = new St.BoxLayout({ vertical: false, style: "spacing: 12px;" });

    const keyLabel = new St.Label({
      text: def.caption,
      y_align: Clutter.ActorAlign.START,
      width: Math.round((t.font ? 80 : 62) * (this._int("font-scale") / 100)),
      style: `color: ${t.dim}; font-size: ${this._fs(11)}px; padding-top: 1px; ${sh}`,
    });

    let dot = null;
    if (def.dot) {
      dot = new St.Label({
        text: "●",
        y_align: Clutter.ActorAlign.START,
        width: 12,
        style: `color: ${t.off}; font-size: ${this._fs(9)}px; padding-top: 3px;`,
      });
    }

    const col = new St.BoxLayout({ vertical: true, x_expand: true, style: "spacing: 1px;" });
    const primaryStyle = `color: ${t.text}; font-size: ${this._fs(13)}px; font-weight: bold; ${sh}`;
    const primary = this._makeValueLabel(primaryStyle, right);
    col.add_child(primary);

    let secondary = null;
    if (def.secondary) {
      secondary = this._makeValueLabel(`color: ${t.dim}; font-size: ${this._fs(11)}px; ${sh}`, right);
      secondary.hide();
      col.add_child(secondary);
    }

    if (right) {
      actor.add_child(col);
      if (dot) actor.add_child(dot);
      actor.add_child(keyLabel);
    } else {
      actor.add_child(keyLabel);
      if (dot) actor.add_child(dot);
      actor.add_child(col);
    }
    this._container.add_child(actor);

    this._rows[def.key] = {
      def,
      actor,
      primary,
      secondary,
      dot,
      primaryStyle,
      flashing: false,
    };
  }

  _makeValueLabel(style, right) {
    const label = new St.Label({
      text: "",
      x_expand: true,
      x_align: right ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
      style,
    });
    const ct = label.clutter_text;
    ct.set_line_wrap(true);
    ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    ct.set_ellipsize(Pango.EllipsizeMode.NONE);
    ct.set_line_alignment(right ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT);
    return label;
  }

  // ---------- row state ----------

  _stateFor(key) {
    if (!this._state[key]) {
      const def = ROW_DEFS.find((d) => d.key === key);
      this._state[key] = {
        primary: "…",
        secondary: null,
        raw: "",
        dotState: null,
        dataVisible: !def?.dataHidden,
      };
    }
    return this._state[key];
  }

  _setRow(key, primary, { secondary = null, raw = "", dotState = null } = {}) {
    const st = this._stateFor(key);
    st.primary = primary;
    st.secondary = secondary;
    st.raw = raw;
    if (dotState) st.dotState = dotState;
    this._paintRow(key);
  }

  _paintRow(key) {
    const row = this._rows[key];
    if (!row) return;
    const st = this._stateFor(key);
    if (!row.flashing) row.primary.set_text(st.primary);
    if (row.secondary) {
      if (st.secondary) {
        row.secondary.set_text(st.secondary);
        row.secondary.show();
      } else {
        row.secondary.hide();
      }
    }
    if (row.dot) {
      const t = this._theme;
      const on = st.dotState === "on";
      const color = on ? t.on : st.dotState === "warn" ? C_WARN : t.off;
      row.dot.set_text(this._dotGlyph(on));
      row.dot.set_style(`color: ${color}; font-size: ${this._fs(9)}px; padding-top: 3px;`);
    }
  }

  _replayState() {
    for (const key of Object.keys(this._rows)) {
      if (this._state[key]) this._paintRow(key);
      else this._rows[key].primary.set_text("…");
    }
  }

  _setDataVisible(key, visible) {
    const st = this._stateFor(key);
    st.dataVisible = visible;
    if (!visible) st.raw = "";
  }

  _applyVisibility() {
    const groupVisible = new Array(GROUP_COUNT).fill(false);
    for (const [key, row] of Object.entries(this._rows)) {
      const show = this._bool(row.def.pref) && this._stateFor(key).dataVisible;
      row.actor.visible = show;
      if (show) groupVisible[row.def.group] = true;
    }
    // A divider shows only between two non-empty sections.
    this._dividers.forEach((d, i) => {
      const before = groupVisible.slice(0, i + 1).some(Boolean);
      const after = groupVisible.slice(i + 1).some(Boolean);
      d.visible = before && after;
    });
  }

  _applyTailscale(ts) {
    const keys = ["tsProfile", "tsIp", "tsExit"];
    if (!ts) {
      keys.forEach((k) => this._setDataVisible(k, false));
    } else {
      keys.forEach((k) => this._setDataVisible(k, true));
      this._setRow("tsProfile", ts.profile);
      this._setRow("tsIp", ts.ip ?? "—", { raw: ts.ip ?? "" });
      this._setRow("tsExit", ts.exit ?? "None");
    }
    this._applyVisibility();
  }

  _setStatusDot() {
    if (!this._statusDot) return;
    const t = this._theme;
    let color = t.off;
    if (this._hasLink) color = this._publicOk === false && this._bool("lookup-public-ip") ? C_WARN : t.on;
    else if (this._publicOk === false && this._bool("lookup-public-ip")) color = C_BAD;
    this._statusDot.set_style(`color: ${color}; font-size: ${this._fs(10)}px;`);
  }

  // ---------- copy ----------

  _copyRow(key) {
    const row = this._rows[key];
    const st = this._stateFor(key);
    if (!row || !st.raw) return;
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, st.raw);
    this._flashCopied(row);
  }

  _flashCopied(row) {
    row.flashing = true;
    row.primary.set_text("Copied");
    row.primary.set_style(
      `color: ${this._theme.accent}; font-size: ${this._fs(13)}px; font-weight: bold; ${this._shadow()}`,
    );
    const id = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COPY_FLASH_MS,
      safe(() => {
        this._flashIds.delete(id);
        row.flashing = false;
        if (this._container && this._rows[row.def.key] === row) {
          row.primary.set_style(row.primaryStyle);
          this._paintRow(row.def.key);
        }
        return GLib.SOURCE_REMOVE;
      }, GLib.SOURCE_REMOVE),
    );
    this._flashIds.add(id);
  }

  _copyableRowAt(x, y) {
    for (const [key, row] of Object.entries(this._rows)) {
      if (!row.def.copy || !this._stateFor(key).raw || !row.actor.visible) continue;
      const [rx, ry] = row.actor.get_transformed_position();
      const [rw, rh] = row.actor.get_transformed_size();
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return key;
    }
    return null;
  }

  // ---------- menu / drag ----------

  _buildMenu() {
    this._menu = new PopupMenu.PopupMenu(this._container, 0.5, St.Side.TOP);
    this._menuManager = new PopupMenu.PopupMenuManager(this);
    this._menuManager.addMenu(this._menu);
    Main.uiGroup.add_child(this._menu.actor);
    this._menu.actor.hide();

    const add = (label, cb) => {
      const item = new PopupMenu.PopupMenuItem(label);
      item.connect("activate", safe(cb));
      this._menu.addMenuItem(item);
      return item;
    };
    const sep = () => this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    add("Refresh", () => this._refreshAll());
    sep();
    add("Copy public IP", () => this._copyRow("public"));
    add("Copy local IP", () => this._copyRow("ip"));
    add("Copy gateway", () => this._copyRow("gateway"));
    add("Copy Tailscale IP", () => this._copyRow("tsIp"));
    sep();

    // Theme submenu: the active theme gets a check mark.
    const themeMenu = new PopupMenu.PopupSubMenuMenuItem("Theme");
    const current = this._settings.get_string("theme");
    for (const id of THEME_ORDER) {
      const item = new PopupMenu.PopupMenuItem(THEMES[id].name);
      item.setOrnament(id === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
      item.connect(
        "activate",
        safe(() => {
          if (id === this._settings.get_string("theme")) return;
          this._menuBusy = true; // rebuild only after the menu has finished closing
          this._settings.set_string("theme", id);
        }),
      );
      themeMenu.menu.addMenuItem(item);
      this._themeItems[id] = item;
    }
    themeMenu.menu.actor.set_style("max-height: 340px;");
    this._menu.addMenuItem(themeMenu);

    add("Settings", () => this.openPreferences());
    sep();
    // "Kill" just disables the extension cleanly; re-enable it to bring the widget back.
    add("Kill", () => this._closeWidget());
  }

  _connectDragHandlers() {
    // Left-click: drag (or, if it didn't move, copy the value under the pointer).
    // Right-click: menu.
    this._container.connect(
      "button-press-event",
      safe((actor, event) => {
        const button = event.get_button();
        if (button === 1) {
          this._dragging = true;
          const [x, y] = event.get_coords();
          this._pressX = x;
          this._pressY = y;
          const [ax, ay] = actor.get_position();
          this._dragOffsetX = x - ax;
          this._dragOffsetY = y - ay;
          try {
            this._grab = global.stage.grab(actor);
          } catch (_e) {
            this._grab = null;
          }
          return Clutter.EVENT_STOP;
        }
        if (button === 3) {
          this._menu.toggle();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      }, Clutter.EVENT_PROPAGATE),
    );

    this._container.connect(
      "motion-event",
      safe((actor, event) => {
        if (!this._dragging || this._bool("lock-position")) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._moveTo(x - this._dragOffsetX, y - this._dragOffsetY);
        return Clutter.EVENT_STOP;
      }, Clutter.EVENT_PROPAGATE),
    );

    this._container.connect(
      "button-release-event",
      safe((actor, event) => {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const moved = Math.hypot(x - this._pressX, y - this._pressY);
        this._endDrag();
        if (moved < CLICK_MOVE_THRESHOLD_PX) {
          if (this._bool("click-to-copy")) {
            const key = this._copyableRowAt(x, y);
            if (key) this._copyRow(key);
          }
        } else if (!this._bool("lock-position")) {
          this._savePosition();
        }
        return Clutter.EVENT_STOP;
      }, Clutter.EVENT_PROPAGATE),
    );

    // If the actor dies mid-drag, never leave a stage grab behind.
    this._container.connect(
      "destroy",
      safe(() => this._endDrag()),
    );
  }

  _endDrag() {
    this._dragging = false;
    if (this._grab) {
      this._grab.dismiss();
      this._grab = null;
    }
  }

  _moveTo(x, y) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !this._container) return;
    const [w, h] = this._container.get_size();
    const cx = Math.min(Math.max(x, monitor.x), monitor.x + Math.max(0, monitor.width - w));
    const cy = Math.min(Math.max(y, monitor.y), monitor.y + Math.max(0, monitor.height - h));
    this._container.set_position(Math.round(cx), Math.round(cy));
  }

  _positionWidget() {
    if (!this._container || !this._settings) return;
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const xp = this._settings.get_double("x-percent");
    const yp = this._settings.get_double("y-percent");
    if (xp >= 0 && yp >= 0) {
      this._moveTo(monitor.x + xp * monitor.width, monitor.y + yp * monitor.height);
    } else {
      this._moveTo(
        monitor.x + monitor.width - this._int("widget-width") - EDGE_PADDING_PX,
        monitor.y + 60,
      );
    }
  }

  // ---------- refresh orchestration ----------

  _refreshAll() {
    this._refreshLocal();
    this._refreshRemote();
  }

  _scheduleDebouncedRefresh() {
    if (this._debounceId) GLib.source_remove(this._debounceId);
    this._debounceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      NETWORK_CHANGE_DEBOUNCE_MS,
      safe(() => {
        this._debounceId = null;
        this._refreshAll();
        return GLib.SOURCE_REMOVE;
      }, GLib.SOURCE_REMOVE),
    );
  }

  // ---------- local info: Wi-Fi, IP, gateway, link speed, proxy, VPN ----------

  async _refreshLocal() {
    if (this._localBusy || !this._container) return;
    this._localBusy = true;
    try {
      const [link, vpn] = await Promise.all([this._readActiveLink(), this._readVpn()]);
      if (!this._container) return;

      this._hasLink = !!link;
      if (link) {
        this._setRow("wifi", link.name, { raw: link.rawName });
        this._setRow("link", link.speed ?? "—");
        this._setRow("ip", link.ip, { secondary: link.method, raw: link.rawIp });
        this._setRow("gateway", link.gateway ?? "—", { raw: link.gateway ?? "" });
      } else {
        this._setRow("wifi", "Not connected");
        this._setRow("link", "—");
        this._setRow("ip", "—");
        this._setRow("gateway", "—");
      }
      this._setRow("proxy", ...this._readProxy());
      this._setRow("vpn", vpn.text, { dotState: vpn.active ? "on" : "off" });
      this._applyTailscale(vpn.tailscale);
      this._setStatusDot();
    } catch (e) {
      console.error(`${TAG} Local refresh failed: ${e}`);
    } finally {
      this._localBusy = false;
    }
  }

  async _readActiveLink() {
    const c = this._cancellable;
    const devs = await run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"], c);
    if (!devs) return null;

    // Prefer Wi-Fi, then Ethernet, among connected devices.
    const connected = devs
      .split("\n")
      .map((l) => l.split(":"))
      .filter(([, type, state]) => state === "connected" && (type === "wifi" || type === "ethernet"));
    const dev =
      connected.find(([, t]) => t === "wifi") ??
      connected.find(([, t]) => t === "ethernet");
    if (!dev) return null;
    const [device, type] = dev;

    const info = await run(
      ["nmcli", "-t", "-f", "GENERAL.CON-UUID,IP4.ADDRESS,IP4.GATEWAY", "device", "show", device],
      c,
    );
    let uuid = null;
    let addr = null;
    let gateway = null;
    for (const line of (info ?? "").split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx);
      const v = line.slice(idx + 1).trim();
      if (k === "GENERAL.CON-UUID") uuid = v;
      else if (k.startsWith("IP4.ADDRESS") && !addr) addr = v.replace(/\\/g, "");
      else if (k === "IP4.GATEWAY" && v && v !== "--") gateway = v;
    }

    let method = null;
    let ssid = null;
    if (uuid) {
      method = await run(["nmcli", "-g", "ipv4.method", "connection", "show", uuid], c);
      if (type === "wifi") {
        ssid = await run(["nmcli", "-g", "802-11-wireless.ssid", "connection", "show", uuid], c);
      }
    }

    // Negotiated link speed, read locally from the driver: no network traffic.
    let speed = null;
    if (type === "wifi") {
      const iw = await run(["iw", "dev", device, "link"], c);
      if (iw) {
        const rx = iw.match(/rx bitrate:\s+([\d.]+)/)?.[1];
        const tx = iw.match(/tx bitrate:\s+([\d.]+)/)?.[1];
        if (rx && tx) speed = `↓ ${Math.round(rx)}  ↑ ${Math.round(tx)} Mbps`;
        else if (tx || rx) speed = `${Math.round(tx ?? rx)} Mbps`;
      }
    } else {
      const mbps = this._readSysfsInt(`/sys/class/net/${device}/speed`, 10);
      if (mbps && mbps > 0) speed = `${mbps} Mbps`;
    }

    const ip = addr ? addr.split("/")[0] : "—";
    const name = type === "wifi" ? (ssid || "Connected") : `Ethernet · ${device}`;
    return {
      name,
      rawName: type === "wifi" ? (ssid ?? "") : "",
      ip,
      rawIp: addr ? ip : "",
      method: method ? (IP4_METHOD_LABELS[method] ?? method) : null,
      gateway,
      speed,
    };
  }

  // Returns [text, options] spread into _setRow.
  _readProxy() {
    try {
      const source = Gio.SettingsSchemaSource.get_default();
      if (!source?.lookup("org.gnome.system.proxy", true)) return ["Unknown", { dotState: "warn" }];
      const proxy = new Gio.Settings({ schema_id: "org.gnome.system.proxy" });
      const mode = proxy.get_string("mode");
      if (mode === "auto") {
        const url = proxy.get_string("autoconfig-url");
        return [url ? `Auto · ${url}` : "Auto", { dotState: "on" }];
      }
      if (mode === "manual") {
        const parts = [];
        for (const [schema, label] of [
          ["org.gnome.system.proxy.http", "HTTP"],
          ["org.gnome.system.proxy.https", "HTTPS"],
          ["org.gnome.system.proxy.socks", "SOCKS"],
          ["org.gnome.system.proxy.ftp", "FTP"],
        ]) {
          if (!source.lookup(schema, true)) continue;
          const s = new Gio.Settings({ schema_id: schema });
          const host = s.get_string("host");
          if (host) parts.push(`${label} ${host}:${s.get_int("port")}`);
        }
        return [parts.length ? parts.join("\n") : "Manual", { dotState: "on" }];
      }
      return ["Off", { dotState: "off" }];
    } catch (e) {
      console.error(`${TAG} Proxy read failed: ${e}`);
      return ["Unknown", { dotState: "warn" }];
    }
  }

  async _readVpn() {
    const c = this._cancellable;
    const found = [];
    let tailscale = null;

    // Tailscale: the interface existing isn't enough; ask the daemon.
    const ts = await run(["tailscale", "status", "--json"], c);
    if (ts) {
      try {
        const st = JSON.parse(ts);
        if (st.BackendState === "Running") {
          tailscale = this._parseTailscale(st);
          found.push("Tailscale");
        }
      } catch (_e) {
        // ignore malformed output
      }
    }

    // NetworkManager VPN / WireGuard connections.
    const active = await run(
      ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show", "--active"],
      c,
    );
    const nmNames = new Set();
    for (const line of (active ?? "").split("\n")) {
      const idx = line.lastIndexOf(":");
      if (idx < 0) continue;
      const name = line.slice(0, idx).replace(/\\:/g, ":");
      const type = line.slice(idx + 1);
      if (type === "vpn" || type === "wireguard") {
        nmNames.add(name);
        found.push(`${name} · ${type === "wireguard" ? "WireGuard" : "VPN"}`);
      }
    }

    // Unmanaged tunnels (openvpn, wg-quick, ...) via interfaces that are up.
    try {
      const dir = Gio.File.new_for_path("/sys/class/net");
      const en = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
      let info;
      while ((info = en.next_file(null))) {
        const name = info.get_name();
        if (!VPN_IFACE_RE.test(name) || name.startsWith("tailscale")) continue;
        if (found.some((f) => f.includes(name)) || nmNames.has(name)) continue;
        const flags = this._readSysfsInt(`/sys/class/net/${name}/flags`, 16);
        // IFF_UP (0x1) and IFF_RUNNING (0x40)
        if (flags !== null && (flags & 0x1) !== 0 && (flags & 0x40) !== 0) {
          found.push(`${name} · tunnel`);
        }
      }
      en.close(null);
    } catch (_e) {
      // /sys unavailable; skip
    }

    return found.length
      ? { active: true, text: found.join("\n"), tailscale }
      : { active: false, text: "Off", tailscale: null };
  }

  // Pull profile, IP and exit node out of `tailscale status --json`.
  _parseTailscale(st) {
    const ips = st.TailscaleIPs ?? st.Self?.TailscaleIPs ?? [];
    const ip = ips.find((a) => !a.includes(":")) ?? ips[0] ?? null;

    const login = st.User?.[String(st.Self?.UserID)]?.LoginName ?? null;
    const tailnet = st.CurrentTailnet?.Name ?? null;
    const profile =
      login && tailnet && login !== tailnet ? `${login} · ${tailnet}` : (login ?? tailnet ?? "Unknown");

    let exit = null;
    const ex = st.ExitNodeStatus;
    if (ex) {
      const peers = Object.values(st.Peer ?? {});
      const peer = peers.find((p) => p.ID === ex.ID) ?? peers.find((p) => p.ExitNode);
      const name = peer?.HostName || peer?.DNSName?.split(".")[0] || null;
      const exIp = (ex.TailscaleIPs ?? peer?.TailscaleIPs ?? [])
        .map((a) => a.split("/")[0])
        .find((a) => !a.includes(":"));
      exit = [name, exIp].filter(Boolean).join(" · ") || "Active";
      if (ex.Online === false) exit += " (offline)";
    }
    return { profile, ip, exit };
  }

  _readSysfsInt(path, radix) {
    try {
      const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
      if (!ok) return null;
      const n = parseInt(new TextDecoder().decode(bytes).trim(), radix);
      return Number.isNaN(n) ? null : n;
    } catch (_e) {
      return null;
    }
  }

  // ---------- remote info: public IP + approximate location ----------

  async _refreshRemote() {
    if (this._remoteBusy || !this._container) return;
    if (!this._bool("lookup-public-ip")) {
      this._publicOk = null;
      this._setRow("public", "Lookup off");
      this._setRow("location", "Lookup off");
      this._setStatusDot();
      return;
    }
    this._remoteBusy = true;
    try {
      let result = null;
      for (const url of IP_LOOKUP_URLS) {
        try {
          result = this._normalizeGeo(await this._fetchJson(url));
          if (result) break;
        } catch (e) {
          console.error(`${TAG} Lookup via ${url} failed: ${e}`);
        }
      }
      if (!this._container) return;

      this._publicOk = !!result;
      if (result) {
        this._setRow("public", result.ip, { raw: result.ip });
        this._setRow("location", result.place, { secondary: result.org });
      } else {
        this._setRow("public", "Unavailable");
        this._setRow("location", "Unavailable");
      }
      this._setStatusDot();
    } catch (e) {
      console.error(`${TAG} Remote refresh failed: ${e}`);
    } finally {
      this._remoteBusy = false;
    }
  }

  _fetchJson(url) {
    if (!this._httpSession) {
      this._httpSession = new Soup.Session({ timeout: 10, user_agent: "gnet-utility/1.0" });
    }
    const message = Soup.Message.new("GET", url);
    return new Promise((resolve, reject) => {
      this._httpSession.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        this._cancellable,
        (session, res) => {
          try {
            const bytes = session.send_and_read_finish(res);
            if (message.status_code !== Soup.Status.OK) {
              throw new Error(`HTTP ${message.status_code}`);
            }
            resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  // Handles both ipinfo.io and ip-api.com response shapes. No coordinates are kept.
  _normalizeGeo(d) {
    const ip = d?.ip ?? d?.query;
    if (!ip) return null;

    const city = d.city;
    let region = d.regionName ?? d.region;
    if (region === city) region = null;
    let country = d.country; // ip-api gives a full name, ipinfo a 2-letter code
    if (country && country.length === 2) {
      try {
        country = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
      } catch (_e) {
        // keep the code
      }
    }

    const place = [city, region, country].filter(Boolean).join(", ") || "Unknown";
    const org = (d.org ?? d.isp ?? "").replace(/^AS\d+\s+/, "");
    return { ip, place, org: org || null };
  }

  // ---------- teardown ----------

  disable() {
    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }
    for (const id of ["_localTimeoutId", "_remoteTimeoutId", "_debounceId", "_rebuildId", "_repositionId", "_closeIdleId"]) {
      if (this[id]) {
        GLib.source_remove(this[id]);
        this[id] = null;
      }
    }
    if (this._networkMonitor && this._networkChangedId) {
      this._networkMonitor.disconnect(this._networkChangedId);
    }
    this._networkMonitor = null;
    this._networkChangedId = null;

    if (this._monitorChangedId) {
      Main.layoutManager.disconnect(this._monitorChangedId);
      this._monitorChangedId = null;
    }
    if (this._settings && this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
    }
    this._settingsChangedId = null;

    if (this._httpSession) {
      this._httpSession.abort();
      this._httpSession = null;
    }
    this._teardownUI();
    this._settings = null;
    this._state = {};
  }
}
