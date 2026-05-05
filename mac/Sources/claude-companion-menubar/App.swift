import AppKit
import Foundation

// Menubar status item for the Claude Companion server.
//
// Lives outside the regular app lifecycle — `setActivationPolicy(.accessory)`
// hides the Dock icon so this binary behaves like a menubar-only app
// without an .app bundle. Run directly:
//
//   swift run -c release   (from ~/claude-companion/mac/)
//
// What it does:
//   - polls /health every 3s; flips the menubar icon between on/off
//   - reads the bearer token from ~/.claude-companion/auth.token, then
//     polls /api/status to surface client/pending counts
//   - menu actions: open dashboard, copy token, restart launchd job, show logs
//
// Why it's tiny: this is the "is it running?" surface, not a full client.
// The PWA + iOS app are the rich UIs.

@main
struct ClaudeCompanionMenubar {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        // NSApplication only weakly retains its delegate; without an explicit
        // hold the local would deallocate before the run loop notices.
        objc_setAssociatedObject(app, "ccm.delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
        app.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var status: ServerStatus = .unknown

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Use a fixed length rather than .variableLength — on macOS 26 with
        // a Pro Display notch, .variableLength items sometimes register but
        // never lay out (the bar can't pick a width). Fixed length is the
        // reliable path. isVisible is explicit for the same reason.
        statusItem = NSStatusBar.system.statusItem(withLength: 28)
        statusItem.isVisible = true
        rebuildMenu()
        Task { await self.poll() }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            Task { @MainActor in await self.poll() }
        }
    }

    private func poll() async {
        let next = await fetchStatus()
        if next != status {
            status = next
            rebuildMenu()
        }
    }

    private func rebuildMenu() {
        let icon = NSImage(systemSymbolName: status.iconName, accessibilityDescription: "Claude Companion")
        icon?.isTemplate = true   // adapt to dark / light menubar tint
        statusItem.button?.image = icon

        let menu = NSMenu()

        let header = NSMenuItem(title: status.headline, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        if let detail = status.detail {
            let item = NSMenuItem(title: detail, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem(title: "Open Dashboard", action: #selector(openDashboard), key: "o"))
        menu.addItem(menuItem(title: "Copy Pairing Token", action: #selector(copyToken), key: "c"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem(title: "Restart Server", action: #selector(restartServer), key: "r"))
        menu.addItem(menuItem(title: "Show Logs", action: #selector(showLogs), key: "l"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), key: "q"))

        statusItem.menu = menu
    }

    private func menuItem(title: String, action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: - Actions

    @objc private func openDashboard() {
        guard let url = URL(string: "http://127.0.0.1:4245") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func copyToken() {
        guard let token = readToken() else {
            notify(title: "No pairing token", body: "Start the companion server once to generate it.")
            return
        }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(token, forType: .string)
    }

    // launchctl kickstart -k restarts the running job (or starts it if
    // stopped). Falls back to no-op + notification if the LaunchAgent
    // isn't installed.
    @objc private func restartServer() {
        let label = "com.techlabstudio.claude-companion"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(label)"]
        let pipe = Pipe()
        task.standardError = pipe
        do {
            try task.run()
            task.waitUntilExit()
            if task.terminationStatus != 0 {
                let err = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                notify(
                    title: "Restart failed",
                    body: err.isEmpty
                        ? "Is the LaunchAgent installed? Try: bun cli.ts daemon install"
                        : err.trimmingCharacters(in: .whitespacesAndNewlines),
                )
            }
        } catch {
            notify(title: "Restart failed", body: error.localizedDescription)
        }
    }

    @objc private func showLogs() {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".claude-companion/companion.log")
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        } else {
            notify(title: "No log yet", body: "The server hasn't run under launchd yet.")
        }
    }

    private func notify(title: String, body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

// MARK: - Server status polling

enum ServerStatus: Equatable {
    case unknown
    case offline
    case noToken
    case running(clients: Int, pending: Int)

    var iconName: String {
        switch self {
        case .running:
            return "antenna.radiowaves.left.and.right.circle.fill"
        case .offline, .unknown:
            return "antenna.radiowaves.left.and.right.slash"
        case .noToken:
            return "lock.fill"
        }
    }

    var headline: String {
        switch self {
        case .unknown: return "Checking…"
        case .offline: return "Server offline"
        case .noToken: return "No pairing token"
        case .running: return "Server running"
        }
    }

    var detail: String? {
        switch self {
        case .running(let clients, let pending):
            var parts: [String] = ["\(clients) client\(clients == 1 ? "" : "s")"]
            if pending > 0 {
                parts.append("\(pending) pending")
            }
            return parts.joined(separator: " · ")
        default:
            return nil
        }
    }
}

private let session: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 2
    cfg.urlCache = nil
    return URLSession(configuration: cfg)
}()

func fetchStatus() async -> ServerStatus {
    let healthURL = URL(string: "http://127.0.0.1:4245/health")!
    do {
        let (_, resp) = try await session.data(from: healthURL)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            return .offline
        }
    } catch {
        return .offline
    }

    guard let token = readToken() else { return .noToken }

    var req = URLRequest(url: URL(string: "http://127.0.0.1:4245/api/status")!)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    do {
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            return .running(clients: 0, pending: 0)
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let clients = (json?["clients"] as? Int) ?? 0
        let pending = (json?["pending"] as? Int) ?? 0
        return .running(clients: clients, pending: pending)
    } catch {
        // /health was up but /api/status timed out — still report as running
        // so the user doesn't see a flicker between green and red.
        return .running(clients: 0, pending: 0)
    }
}

func readToken() -> String? {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent(".claude-companion/auth.token")
    guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
}
