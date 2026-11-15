import Cocoa
import AuthenticationServices

// This helper uses the system browser. It never receives the user's password.
final class LoginDelegate: NSObject, NSApplicationDelegate, ASWebAuthenticationPresentationContextProviding, NSWindowDelegate {
    private var window: NSWindow!
    private var session: ASWebAuthenticationSession?

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 140),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Sign in to myQ for Homebridge"
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard let input = readLine(), let data = input.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let rawURL = request["authorizationURL"], let url = URL(string: rawURL),
              url.scheme == "https", url.host == "partner-identity.myq-cloud.com",
              url.path == "/connect/authorize" else { finish(["error": "Invalid sign-in request"]); return }
        session = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.myqops") { callback, error in
            DispatchQueue.main.async {
                if let callback = callback { self.finish(["callback": callback.absoluteString]) }
                else { self.finish(["error": "Sign-in was cancelled or could not be completed"]) }
            }
        }
        session?.presentationContextProvider = self
        session?.prefersEphemeralWebBrowserSession = true
        if session?.start() != true { finish(["error": "System sign-in could not start"]) }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }
    func windowWillClose(_ notification: Notification) { session?.cancel() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    private func finish(_ result: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: result) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = LoginDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
