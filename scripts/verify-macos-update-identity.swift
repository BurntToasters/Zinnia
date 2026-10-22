// Exercise the production Rust transaction with real macOS file bookmarks.
import Foundation
let fm = FileManager.default
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let app = root.appendingPathComponent("Don't ' duplicate.app", isDirectory: true)
let stage = root.appendingPathComponent("stage", isDirectory: true)
let backup = root.appendingPathComponent("backup", isDirectory: true)
for (bundle, value) in [(app, "old"), (stage, "new")] {
    try fm.createDirectory(at: bundle.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    try value.write(to: bundle.appendingPathComponent("Contents/version"), atomically: true, encoding: .utf8)
}
func inode() throws -> UInt64 {
    (try fm.attributesOfItem(atPath: app.path)[.systemFileNumber] as! NSNumber).uint64Value
}
let before = try inode()
let bookmark = try app.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
let child = Process()
child.executableURL = root.appendingPathComponent("install")
child.arguments = [stage.path, app.path, backup.path]
try child.run()
child.waitUntilExit()
precondition(child.terminationStatus == 0, "Production installer failed")
let after = try inode()
var stale = false
let resolved = try URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
let version = try String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8)
precondition(before == after, "Outer app identity changed")
precondition(!stale, "macOS bookmark became stale")
precondition(resolved.standardizedFileURL.resolvingSymlinksInPath() == app.standardizedFileURL.resolvingSymlinksInPath(), "Bookmark no longer targets installed app")
precondition(version == "new" && !fm.fileExists(atPath: backup.path), "Update incomplete")
// Run the exact AppleScript/shell transaction as the current user. Removing
// elevation avoids an authorization prompt; actual admin ownership is manual.
let source = try String(contentsOfFile: "src-tauri/vendor/tauri-plugin-updater/src/install_safety.rs", encoding: .utf8)
let scriptStart = source.range(of: "on installUpdate")!.lowerBound
let scriptEnd = source.range(of: "end installUpdate")!.upperBound
let script = String(source[scriptStart..<scriptEnd]).replacingOccurrences(of: " with administrator privileges", with: "")
    + "\non run argv\nreturn installUpdate(item 1 of argv, item 2 of argv, item 3 of argv)\nend run\n"
func runScript(_ body: String) throws -> Int32 {
    let path = root.appendingPathComponent("install.applescript")
    try body.write(to: path, atomically: true, encoding: .utf8)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [path.path, app.path, stage.path, backup.path]
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
}
try fm.createDirectory(at: stage.appendingPathComponent("Contents"), withIntermediateDirectories: true)
try "script-new".write(to: stage.appendingPathComponent("Contents/version"), atomically: true, encoding: .utf8)
let scriptStatus = try runScript(script)
precondition(scriptStatus == 0, "AppleScript transaction failed")
let scriptInode = try inode()
precondition(scriptInode == before, "AppleScript changed app identity")
let scriptVersion = try String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8)
precondition(scriptVersion == "script-new", "AppleScript did not install update")
// Inject a move failure after backup; execute rollback through AppleScript too.
try fm.createDirectory(at: stage.appendingPathComponent("Contents"), withIntermediateDirectories: true)
let failingScript = script.replacingOccurrences(of: #"/bin/mv -f \"$NEW/Contents\" \"$SRC/Contents\""#, with: "/usr/bin/false")
precondition(failingScript != script, "Fault injection did not match")
let failureStatus = try runScript(failingScript)
precondition(failureStatus != 0, "Injected move unexpectedly succeeded")
let restoredVersion = try String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8)
precondition(restoredVersion == "script-new", "AppleScript rollback lost live contents")
let rollbackInode = try inode()
precondition(rollbackInode == before, "Rollback changed app identity")
let result: [String: Any] = [
    "status": "passed", "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "timestamp": ISO8601DateFormatter().string(from: Date()),
    "outerInodeBefore": before, "outerInodeAfter": after,
    "bookmarkStale": stale, "installedVersion": version,
    "appleScriptInstall": "passed without elevation", "appleScriptRollback": "passed with injected move failure",
    "scope": "Native filesystem and bookmark integration; signed update and visual Dock validation pending"
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print(String(decoding: data, as: UTF8.self))
