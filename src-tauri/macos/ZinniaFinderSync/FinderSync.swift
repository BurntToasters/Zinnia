import Cocoa
import FinderSync

/// Finder Sync extension: adds Extract / Compress to Finder's primary context menu.
/// Requests are atomically queued in the shared App Group before waking Zinnia.
final class FinderSync: FIFinderSync {
  private struct Request: Codable {
    let createdAtMs: UInt64
    let mode: String
    let paths: [String]
  }

  /// Zinnia logo for context menu items. Loaded once from the extension bundle.
  /// isTemplate=true lets AppKit render it correctly in light/dark mode and
  /// when the item is selected (white-on-blue), matching system menu icon style.
  private lazy var menuIcon: NSImage? = {
    let bundle = Bundle(for: type(of: self))
    guard let path = bundle.path(forResource: "zinnia-menu", ofType: "png"),
          let image = NSImage(contentsOfFile: path)
    else { return nil }
    image.isTemplate = true
    return image
  }()

  private let archiveExtensions: Set<String> = [
    "7z", "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "rar", "001",
  ]
  private let maximumPathsPerRequest = 1_000

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
      extract.image = menuIcon
      menu.addItem(extract)
    }

    let compress = NSMenuItem(
      title: "Compress with Zinnia",
      action: #selector(compressSelected(_:)),
      keyEquivalent: ""
    )
    compress.target = self
    compress.image = menuIcon
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
    guard urls.count <= maximumPathsPerRequest else {
      NSLog("ZinniaFinderSync: selection exceeds the 1,000-item safety limit")
      return
    }
    guard let appURL = hostAppURL() else {
      NSLog("ZinniaFinderSync: could not locate host Zinnia.app")
      return
    }
    guard let requestURL = queueRequest(mode: mode, urls: urls) else { return }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true

    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
      if let error {
        // Do not execute an action unexpectedly on a later normal app launch.
        try? FileManager.default.removeItem(at: requestURL)
        NSLog("ZinniaFinderSync: failed to open host: \(error.localizedDescription)")
      }
    }
  }

  /// `NSWorkspace.OpenConfiguration.arguments` are ignored for sandboxed
  /// callers. Persist the request first so this works for cold and warm hosts.
  private func queueRequest(mode: String, urls: [URL]) -> URL? {
    guard let groupID = Bundle.main.object(forInfoDictionaryKey: "ZinniaAppGroupIdentifier") as? String,
          let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: groupID
          ) else {
      NSLog("ZinniaFinderSync: App Group container is unavailable")
      return nil
    }

    let requests = container.appendingPathComponent("FinderSyncRequests", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: requests, withIntermediateDirectories: true)
      let createdAtMs = UInt64(Date().timeIntervalSince1970 * 1_000)
      let request = Request(
        createdAtMs: createdAtMs,
        mode: mode == "--compress" ? "compress" : "extract",
        paths: urls.map(\.path)
      )
      let data = try JSONEncoder().encode(request)
      let name = String(format: "%013llu-%@.json", createdAtMs, UUID().uuidString)
      let destination = requests.appendingPathComponent(name)
      try data.write(to: destination, options: .atomic)
      return destination
    } catch {
      NSLog("ZinniaFinderSync: could not queue request: \(error.localizedDescription)")
      return nil
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
