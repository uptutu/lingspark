# dmgbuild settings for the Mac installer window (D-063). dmgbuild writes the
# window layout straight into the image, without driving Finder, so building
# never opens a window. Values come in from scripts/build-mac.mjs via -D.
#
# Icon positions are window points and must match build/dmg-background.swift.

app = defines["app"]  # noqa: F821 -- provided by dmgbuild
background = defines["background"]  # noqa: F821

format = "ULMO"
filesystem = "APFS"
files = [app]
symlinks = {"应用程序": "/Applications"}
icon = defines["volume_icon"]  # noqa: F821

window_rect = ((200, 160), (540, 340))
background = background
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
default_view = "icon-view"
show_icon_preview = False

icon_size = 96
text_size = 12
arrange_by = None
icon_locations = {
    "LingSpark.app": (135, 170),
    "应用程序": (405, 170),
}
