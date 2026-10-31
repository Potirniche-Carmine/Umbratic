import Cocoa

final class FolderDelegate: NSObject, NSApplicationDelegate {
    // Ignore all URL contents: only this fixed directory can be opened.
    func application(_ application: NSApplication, open urls: [URL]) {}
    func applicationDidFinishLaunching(_ notification: Notification) {
        let folder = URL(fileURLWithPath: "/Library/Application Support/Umbratic/Veil Console/Models", isDirectory: true)
        if !NSWorkspace.shared.open(folder) {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "The models folder could not be opened."
            alert.informativeText = "Copy its path from Console and open it in Finder."
            alert.runModal()
        }
        NSApp.terminate(nil)
    }
}
let app = NSApplication.shared
let delegate = FolderDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
