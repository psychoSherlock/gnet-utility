UUID     := gnet-utility@psychosherlock
DEST     := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES  := extension.js prefs.js themes.js metadata.json schemas/*.gschema.xml

.PHONY: install uninstall pack previews clean

## Copy the extension into your user extensions folder.
install:
	mkdir -p $(DEST)/schemas
	cp extension.js prefs.js themes.js metadata.json $(DEST)/
	cp schemas/*.gschema.xml $(DEST)/schemas/
	glib-compile-schemas $(DEST)/schemas
	@echo "Installed to $(DEST)"
	@echo "Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

## Build a zip suitable for extensions.gnome.org / manual install.
pack:
	gnome-extensions pack --force --extra-source=themes.js --out-dir=dist .

## Re-render docs/screenshots from themes.js (needs Node and Chromium).
previews:
	node tools/render-previews.mjs

clean:
	rm -rf dist schemas/gschemas.compiled
