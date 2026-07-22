import Cocoa
import FinderSync

/// Finder Sync extension: adds Extract / Compress to Finder's primary context menu.
/// Launches the host Zinnia.app with `--extract` / `--compress` + absolute paths.
final class FinderSync: FIFinderSync {
  private let archiveExtensions: Set<String> = [
    "7z", "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "rar", "001",
  ]

  override init() {
    super.init()
    // Watch the whole volume tree so menus appear for any Finder selection.
    FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
  }

  override func menu(for menuKind: FIMenuKind) -> NSMenu {
    let menu = NSMenu(title: "")
    let urls = selectedItemURLs()
    guard !urls.isEmpty else { return menu }

    if urls.contains(where: isArchiveURL) {
      let extract = NSMenuItem(
        title: "Extract with Zinnia",
        action: #selector(extractSelected(_:)),
        keyEquivalent: ""
      )
      extract.target = self
      menu.addItem(extract)
    }

    let compress = NSMenuItem(
      title: "Compress with Zinnia",
      action: #selector(compressSelected(_:)),
      keyEquivalent: ""
    )
    compress.target = self
    menu.addItem(compress)
    return menu
  }

  @objc private func extractSelected(_: AnyObject?) {
    launchHost(mode: "--extract", urls: selectedItemURLs().filter(isArchiveURL))
  }

  @objc private func compressSelected(_: AnyObject?) {
    launchHost(mode: "--compress", urls: selectedItemURLs())
  }

  private func selectedItemURLs() -> [URL] {
    let controller = FIFinderSyncController.default()
    if let selected = controller.selectedItemURLs(), !selected.isEmpty {
      return selected
    }
    if let targeted = controller.targetedURL() {
      return [targeted]
    }
    return []
  }

  private func isArchiveURL(_ url: URL) -> Bool {
    let name = url.lastPathComponent.lowercased()
    if name.hasSuffix(".tar.gz") || name.hasSuffix(".tar.bz2") || name.hasSuffix(".tar.xz") {
      return true
    }
    let ext = url.pathExtension.lowercased()
    return archiveExtensions.contains(ext)
  }

  private func launchHost(mode: String, urls: [URL]) {
    guard !urls.isEmpty else { return }
    guard let appURL = hostAppURL() else {
      NSLog("ZinniaFinderSync: could not locate host Zinnia.app")
      return
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.arguments = [mode] + urls.map(\.path)
    configuration.activates = true

    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
      if let error {
        NSLog("ZinniaFinderSync: failed to open host: \(error.localizedDescription)")
      }
    }
  }

  /// `…/Zinnia.app/Contents/PlugIns/ZinniaFinderSync.appex` → `…/Zinnia.app`
  private func hostAppURL() -> URL? {
    let appexURL = Bundle.main.bundleURL
    let plugins = appexURL.deletingLastPathComponent()
    let contents = plugins.deletingLastPathComponent()
    let app = contents.deletingLastPathComponent()
    guard app.pathExtension == "app" else { return nil }
    return app
  }
}
