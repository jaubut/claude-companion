import AppKit
import CoreImage
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
//   - renders a live scannable Pairing QR code ({"v":1,"url":"...","token":"..."})
//     directly inside the menubar dropdown AND in a pop-out window
//   - menu actions: show QR window, copy token, restart launchd job, show logs, quit

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
    private var qrPanel: NSPanel?
    private var cachedServerURL: String = detectTailscaleHTTPSURL()

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

        // Inline Scannable Pairing QR Code right inside the menubar dropdown
        if let token = readToken(),
           let payloadJSON = makePairingPayloadJSON(url: cachedServerURL, token: token),
           let qrImage = makeQRCodeImage(from: payloadJSON, size: 168) {
            menu.addItem(NSMenuItem.separator())
            let qrItem = NSMenuItem()
            qrItem.view = buildInlineQRMenuView(qrImage: qrImage, urlString: cachedServerURL)
            menu.addItem(qrItem)
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem(title: "Show Pairing QR Window…", action: #selector(showQRWindow), key: "p"))
        menu.addItem(menuItem(title: "Copy Pairing Token", action: #selector(copyToken), key: "c"))
        menu.addItem(menuItem(title: "Copy Server URL", action: #selector(copyServerURL), key: "u"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem(title: "Restart Server", action: #selector(restartServer), key: "r"))
        menu.addItem(menuItem(title: "Show Logs", action: #selector(showLogs), key: "l"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem(title: "Quit Companion Menubar", action: #selector(quitMenubar), key: ""))

        statusItem.menu = menu
    }

    private func menuItem(title: String, action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func buildInlineQRMenuView(qrImage: NSImage, urlString: String) -> NSView {
        let width: CGFloat = 224
        let height: CGFloat = 236
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

        let titleLabel = NSTextField(labelWithString: "Scan on iPhone to Pair")
        titleLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
        titleLabel.textColor = NSColor.labelColor
        titleLabel.alignment = .center
        titleLabel.frame = NSRect(x: 12, y: height - 24, width: width - 24, height: 16)
        container.addSubview(titleLabel)

        let cardSize: CGFloat = 176
        let cardX = (width - cardSize) / 2
        let cardY: CGFloat = 32
        let whiteCard = NSView(frame: NSRect(x: cardX, y: cardY, width: cardSize, height: cardSize))
        whiteCard.wantsLayer = true
        whiteCard.layer?.backgroundColor = NSColor.white.cgColor
        whiteCard.layer?.cornerRadius = 12
        whiteCard.layer?.borderWidth = 1
        whiteCard.layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor

        let imgView = NSImageView(frame: NSRect(x: 4, y: 4, width: cardSize - 8, height: cardSize - 8))
        imgView.image = qrImage
        imgView.imageScaling = .scaleProportionallyUpOrDown
        whiteCard.addSubview(imgView)
        container.addSubview(whiteCard)

        let shortHost = urlString.replacingOccurrences(of: "https://", with: "")
        let hostLabel = NSTextField(labelWithString: shortHost)
        hostLabel.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        hostLabel.textColor = NSColor.secondaryLabelColor
        hostLabel.alignment = .center
        hostLabel.lineBreakMode = .byTruncatingMiddle
        hostLabel.frame = NSRect(x: 10, y: 8, width: width - 20, height: 16)
        container.addSubview(hostLabel)

        return container
    }

    // MARK: - Actions

    @objc private func showQRWindow() {
        cachedServerURL = detectTailscaleHTTPSURL()
        guard let token = readToken(),
              let payloadJSON = makePairingPayloadJSON(url: cachedServerURL, token: token),
              let qrImage = makeQRCodeImage(from: payloadJSON, size: 240) else {
            notify(title: "No pairing token", body: "Start the companion server once to generate ~/.claude-companion/auth.token.")
            return
        }

        if let existing = qrPanel {
            existing.close()
            qrPanel = nil
        }

        let panelWidth: CGFloat = 320
        let panelHeight: CGFloat = 390
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.titled, .closable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Pair Claude Companion"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.center()

        let content = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))

        let heading = NSTextField(labelWithString: "Scan from Companion on iPhone")
        heading.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        heading.alignment = .center
        heading.frame = NSRect(x: 16, y: panelHeight - 36, width: panelWidth - 32, height: 20)
        content.addSubview(heading)

        let sub = NSTextField(labelWithString: "Settings & Pairing → Pair QR / token")
        sub.font = NSFont.systemFont(ofSize: 11.5)
        sub.textColor = .secondaryLabelColor
        sub.alignment = .center
        sub.frame = NSRect(x: 16, y: panelHeight - 56, width: panelWidth - 32, height: 16)
        content.addSubview(sub)

        let cardSize: CGFloat = 256
        let whiteCard = NSView(frame: NSRect(x: (panelWidth - cardSize) / 2, y: 66, width: cardSize, height: cardSize))
        whiteCard.wantsLayer = true
        whiteCard.layer?.backgroundColor = NSColor.white.cgColor
        whiteCard.layer?.cornerRadius = 16
        whiteCard.layer?.borderWidth = 1
        whiteCard.layer?.borderColor = NSColor.black.withAlphaComponent(0.1).cgColor

        let qrView = NSImageView(frame: NSRect(x: 8, y: 8, width: cardSize - 16, height: cardSize - 16))
        qrView.image = qrImage
        qrView.imageScaling = .scaleProportionallyUpOrDown
        whiteCard.addSubview(qrView)
        content.addSubview(whiteCard)

        let urlField = NSTextField(labelWithString: cachedServerURL)
        urlField.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        urlField.textColor = .secondaryLabelColor
        urlField.alignment = .center
        urlField.isSelectable = true
        urlField.frame = NSRect(x: 16, y: 36, width: panelWidth - 32, height: 18)
        content.addSubview(urlField)

        let copyBtn = NSButton(title: "Copy Pairing Token", target: self, action: #selector(copyToken))
        copyBtn.bezelStyle = .rounded
        copyBtn.frame = NSRect(x: (panelWidth - 160) / 2, y: 8, width: 160, height: 24)
        content.addSubview(copyBtn)

        panel.contentView = content
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        self.qrPanel = panel
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

    @objc private func copyServerURL() {
        cachedServerURL = detectTailscaleHTTPSURL()
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(cachedServerURL, forType: .string)
    }

    @objc private func quitMenubar() {
        NSApplication.shared.terminate(nil)
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

// MARK: - Pairing QR Code & Tailscale URL Detection

func detectTailscaleHTTPSURL() -> String {
    let candidates = [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]
    for bin in candidates where FileManager.default.isExecutableFile(atPath: bin) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["status", "--json"]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = Pipe()
        do {
            try proc.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            if proc.terminationStatus == 0,
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let selfNode = json["Self"] as? [String: Any],
               let rawDNS = selfNode["DNSName"] as? String {
                let trimmed = rawDNS.trimmingCharacters(in: CharacterSet(charactersIn: ". \t\n"))
                if !trimmed.isEmpty {
                    return "https://\(trimmed)"
                }
            }
        } catch {
            continue
        }
    }
    return "https://m2-max-ji-dog.tailfc45f2.ts.net"
}

func makePairingPayloadJSON(url: String, token: String) -> String? {
    let payload: [String: Any] = [
        "v": 1,
        "url": url,
        "token": token,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes]) else {
        return nil
    }
    return String(data: data, encoding: .utf8)
}

func makeQRCodeImage(from string: String, size: CGFloat) -> NSImage? {
    guard let data = string.data(using: .utf8),
          let filter = CIFilter(name: "CIQRCodeGenerator") else {
        return nil
    }
    filter.setValue(data, forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }

    let extent = output.extent.integral
    guard extent.width > 0, extent.height > 0 else { return nil }
    let scale = max(1, floor(size / max(extent.width, extent.height)))
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

    let rep = NSCIImageRep(ciImage: scaled)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    return image
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
