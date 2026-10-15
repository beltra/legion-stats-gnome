UUID = legion-stats@beltra.github.io

pack:
	gnome-extensions pack --force --extra-source=LICENSE --schema=schemas/org.gnome.shell.extensions.legion-stats.gschema.xml .

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip

.PHONY: pack install
