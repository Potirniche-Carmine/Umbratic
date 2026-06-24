# macOS Liquid Glass Icon Notes

Apple's Liquid Glass app icon system uses layered 1024x1024 artwork with appearance annotations for Default, Dark, Clear, and Tinted/Mono modes. The static `umbratic-icon-512.png` is only the development/runtime Dock fallback used by Electron.

For a packaged macOS app, import these layers into Apple's Icon Composer:

- `background-default-1024.png`
- `foreground-logo-white-1024.png` for Default/Dark appearances
- `foreground-logo-template-1024.png` for Mono/Tinted appearances
- `foreground-logo-tint-preview-1024.png` as a blue preview of the Mono/Tinted foreground

In Icon Composer, keep the Mono/Tinted foreground as template-style artwork so macOS can recolor the logo to the user's selected icon/widget color. Export an `.icon` file from Icon Composer and configure the macOS packager to use it as the bundle icon. Do not replace the packaged Dock icon at runtime with `app.dock.setIcon(...)`; a static PNG override prevents macOS from applying the packaged icon's adaptive appearances.
