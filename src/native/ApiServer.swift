import Foundation
import Network
import Security

/// Kept separate from the host's own error type so this file drops into either
/// app unchanged.
struct ApiServerError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/**
 The local HTTP API.

 Database Studio keeps its active sources in the renderer and native adapters,
 so ordinary API calls are handed to the web view and resolved against the
 source that is actually open.

 That indirection is the point. A tool asking over this API sees exactly what
 the canvas shows — including nodes an ingest run added a second ago and has not
 saved yet — and every call appears live in the app's API tab.

 This is a second listener, next to the ingest server the Chrome extension talks
 to. They are kept apart deliberately: the extension endpoint accepts one narrow
 kind of payload and needs no token because it grants nothing, while this one
 can read and write the whole graph and therefore requires the bearer token from
 `api.json` in Application Support. Both bind to 127.0.0.1 only.

 The API is off until it is switched on in the app, and the setting is
 remembered.
 */
final class ApiServer {
    struct Config {
        let appName: String
        /// Stable folder name, independent of the app's visible brand.
        let storageDirectoryName: String
        let version: String
        /// Written next to the port so a client can find both without being told.
        let tokenFileName: String
    }

    /// One request on its way into the renderer.
    struct Call {
        let method: String
        let path: String
        let query: [String: String]
        let body: Data
    }

    /// What the renderer sent back: an HTTP status and a ready-made JSON body.
    struct Reply {
        let status: Int
        let json: Data
    }

    private let config: Config
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "studio.api", attributes: .concurrent)
    private let lock = NSLock()
    private var token: String = ""

    /// Called on the main queue for every authenticated request. The completion
    /// must be invoked exactly once; `ApiServer` gives up on it after a timeout.
    var onCall: ((Call, @escaping (Reply) -> Void) -> Void)?

    /// Reported by `/api/v1/health` without a round trip into JavaScript, so a
    /// health check answers even while the renderer is busy.
    private var healthSnapshot: [String: Any] = [:]

    private(set) var port: UInt16 = 0
    var isRunning: Bool { listener?.state == .ready }

    /// Seconds a call may spend in the renderer before the client is told so.
    private let callTimeout: TimeInterval = 30

    init(config: Config) {
        self.config = config
    }

    // MARK: - Lifecycle

    func start(port requested: UInt16) throws {
        if isRunning && requested == port { return }
        // Read a descriptor left by an older Database Studio build before stop
        // removes it. New builds persist the token separately below.
        ensureToken()
        stop()

        guard let nwPort = NWEndpoint.Port(rawValue: requested) else {
            throw ApiServerError("Ungültiger Port: \(requested)")
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: nwPort)

        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }

        var startError: Error?
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed(let error), .waiting(let error):
                startError = error
                ready.signal()
            default:
                break
            }
        }

        listener.start(queue: queue)
        self.listener = listener
        self.port = requested

        // A port already in use fails asynchronously; without this wait the app
        // would report a server that never came up.
        if ready.wait(timeout: .now() + 2) == .timedOut {
            stop()
            throw ApiServerError("Port \(requested) antwortet nicht.")
        }
        if let error = startError {
            stop()
            throw ApiServerError("Port \(requested) ist belegt: \(error.localizedDescription)")
        }

        writeDescriptor()
    }

    func stop() {
        listener?.cancel()
        listener = nil
        removeDescriptor()
    }

    // MARK: - Token

    var currentToken: String {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    @discardableResult
    func rotateToken() -> String {
        lock.lock()
        token = Self.makeToken()
        lock.unlock()
        persistToken()
        if isRunning { writeDescriptor() }
        return currentToken
    }

    /// Reuses the token from a previous run so a configured client keeps working
    /// across restarts; mints one on the very first start.
    private func ensureToken() {
        lock.lock()
        let existing = token
        lock.unlock()
        if !existing.isEmpty { return }

        let tokenFileValue = (try? String(contentsOf: tokenURL, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let descriptorValue = (try? Data(contentsOf: descriptorURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .flatMap { $0?["token"] as? String }
        let stored = tokenFileValue?.isEmpty == false ? tokenFileValue : descriptorValue

        lock.lock()
        token = (stored?.isEmpty == false ? stored! : Self.makeToken())
        lock.unlock()
        persistToken()
    }

    private static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Descriptor file

    /**
     Where a client looks the connection up. Writing port and token to a
     predictable path is what lets the MCP server work with no configuration at
     all — and the file is owner-readable only, because the token in it is the
     whole access control.
     */
    var descriptorURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base
            .appendingPathComponent(config.storageDirectoryName, isDirectory: true)
            .appendingPathComponent(config.tokenFileName)
    }

    /// Durable credential. `api.json` is an online descriptor and is removed
    /// when the listener stops; keeping the secret separate preserves client
    /// configuration across graceful relaunches.
    var tokenURL: URL {
        descriptorURL.deletingLastPathComponent().appendingPathComponent("api-token")
    }

    private func persistToken() {
        let directory = tokenURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try? Data((currentToken + "\n").utf8).write(to: tokenURL, options: .atomic)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: tokenURL.path
        )
    }

    private func writeDescriptor() {
        let payload: [String: Any] = [
            "app": config.appName,
            "version": config.version,
            "url": "http://127.0.0.1:\(port)",
            "port": Int(port),
            "token": currentToken,
            "updatedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) else { return }

        let directory = descriptorURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: descriptorURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: descriptorURL.path)
    }

    private func removeDescriptor() {
        try? FileManager.default.removeItem(at: descriptorURL)
    }

    /// Replaces the combined snapshot, or updates exactly one adapter without
    /// discarding the other studios' last-known health state.
    func updateHealth(_ snapshot: [String: Any], adapter: String? = nil) {
        lock.lock()
        if let adapter {
            healthSnapshot[adapter] = snapshot
        } else {
            healthSnapshot = snapshot
        }
        lock.unlock()
    }

    private func readHealth() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return healthSnapshot
    }

    // MARK: - Connections

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if error != nil || (data == nil && isComplete) {
                connection.cancel()
                return
            }

            var accumulated = buffer
            if let data { accumulated.append(data) }

            guard let request = ApiRequest(accumulated) else {
                // Headers or body not fully arrived yet. A long INSERT can span
                // several segments, so keep reading until the declared body is in.
                if accumulated.count > 64 * 1024 * 1024 {
                    self.send(connection, status: 413, json: ["error": "Anfrage zu groß"])
                    return
                }
                self.receive(connection, buffer: accumulated)
                return
            }

            self.handle(request, on: connection)
        }
    }

    private func handle(_ request: ApiRequest, on connection: NWConnection) {
        if request.method == "OPTIONS" {
            send(connection, status: 204, body: Data(), contentType: nil)
            return
        }

        // Unauthenticated on purpose: a client needs some way to see whether the
        // port belongs to this app before it has a token to offer.
        if request.method == "GET" && request.path == "/api/v1/ping" {
            send(connection, status: 200, json: [
                "ok": true,
                "app": config.appName,
                "version": config.version,
                "authenticated": false,
            ])
            return
        }

        guard request.path.hasPrefix("/api/") else {
            send(connection, status: 404, json: ["error": "Unbekannter Pfad: \(request.path)"])
            return
        }

        guard authorize(request) else {
            send(connection, status: 401, json: [
                "error": "Ungültiges oder fehlendes Token.",
                "hint": "Authorization: Bearer <token> aus \(descriptorURL.path)",
            ])
            return
        }

        // Health is answered from the snapshot the renderer pushes, so a probe
        // still succeeds while a long query is occupying the JavaScript thread.
        if request.method == "GET",
           request.path == "/api/v1/health" || Self.healthAdapter(for: request.path) != nil {
            let health = readHealth()
            let adapter = Self.healthAdapter(for: request.path)
            var payload: [String: Any]
            if let adapter {
                payload = health[adapter] as? [String: Any] ?? [:]
            } else {
                payload = health
            }
            payload["ok"] = true
            payload["app"] = config.appName
            payload["version"] = config.version
            payload["port"] = Int(port)
            if let adapter { payload["adapter"] = adapter }
            send(connection, status: 200, json: payload)
            return
        }

        guard let onCall else {
            send(connection, status: 503, json: ["error": "Die App ist noch nicht bereit."])
            return
        }

        let call = Call(
            method: request.method,
            path: request.path,
            query: request.query,
            body: request.body
        )

        // The renderer answers on the main queue; `answered` makes sure a late
        // reply after the timeout does not write to a cancelled connection.
        let answered = NSLock()
        var isAnswered = false
        let finish: (Reply) -> Void = { [weak self] reply in
            answered.lock()
            let alreadyAnswered = isAnswered
            isAnswered = true
            answered.unlock()
            guard !alreadyAnswered, let self else { return }
            self.send(connection, status: reply.status, body: reply.json,
                      contentType: "application/json; charset=utf-8")
        }

        queue.asyncAfter(deadline: .now() + callTimeout) {
            finish(Reply(
                status: 504,
                json: Self.encode(["error": "Zeitüberschreitung: die App hat nicht geantwortet."])
            ))
        }

        DispatchQueue.main.async { onCall(call, finish) }
    }

    private func authorize(_ request: ApiRequest) -> Bool {
        let expected = currentToken
        guard !expected.isEmpty else { return false }

        if let header = request.headers["authorization"] {
            let offered = header.hasPrefix("Bearer ") ? String(header.dropFirst(7)) : header
            if constantTimeEquals(offered.trimmingCharacters(in: .whitespaces), expected) { return true }
        }
        if let header = request.headers["x-api-token"], constantTimeEquals(header, expected) { return true }
        // Query parameter as a fallback, for a quick `curl` or a browser tab.
        if let value = request.query["token"], constantTimeEquals(value, expected) { return true }
        return false
    }

    private static func healthAdapter(for path: String) -> String? {
        switch path {
        case "/api/v1/sqlite/health": return "sqlite"
        case "/api/v1/graph/health": return "graph"
        case "/api/v1/vault/health": return "vault"
        default: return nil
        }
    }

    /// Compares without an early exit, so a wrong token cannot be guessed one
    /// character at a time from how long the answer takes.
    private func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8), b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in a.indices { difference |= a[index] ^ b[index] }
        return difference == 0
    }

    // MARK: - Responses

    private static func encode(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    }

    private func send(_ connection: NWConnection, status: Int, json: [String: Any]) {
        send(connection, status: status, body: Self.encode(json),
             contentType: "application/json; charset=utf-8")
    }

    private func send(_ connection: NWConnection, status: Int, body: Data, contentType: String?) {
        var header = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        header += "Content-Length: \(body.count)\r\n"
        if let contentType { header += "Content-Type: \(contentType)\r\n" }
        // The token is what guards the API, not the origin: callers are local
        // processes and browser tools whose origin is nothing stable.
        header += "Access-Control-Allow-Origin: *\r\n"
        header += "Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS\r\n"
        header += "Access-Control-Allow-Headers: Content-Type, Authorization, X-Api-Token\r\n"
        header += "Access-Control-Max-Age: 86400\r\n"
        header += "Connection: close\r\n\r\n"

        var response = Data(header.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 201: return "Created"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 413: return "Payload Too Large"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        case 504: return "Gateway Timeout"
        default: return "Error"
        }
    }
}

/**
 Just enough HTTP/1.1 to serve the routes above — the same shape the ingest
 parser has, plus the query string and the headers, which the API needs for
 paging and for the bearer token.

 A `nil` result means "not a complete request yet", which is how the read loop
 knows to keep going.
 */
struct ApiRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]
    let body: Data

    init?(_ data: Data) {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerEnd = data.range(of: separator) else { return nil }

        let headerData = data.subdata(in: data.startIndex..<headerEnd.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }

        let lines = headerText.components(separatedBy: "\r\n")
        let requestLine = lines.first?.components(separatedBy: " ") ?? []
        guard requestLine.count >= 2 else { return nil }

        method = requestLine[0].uppercased()

        let target = requestLine[1]
        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        path = String(parts.first ?? "")
        query = parts.count > 1 ? Self.parseQuery(String(parts[1])) : [:]

        var collected: [String: String] = [:]
        for line in lines.dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1).map(String.init)
            guard pair.count == 2 else { continue }
            collected[pair[0].lowercased()] = pair[1].trimmingCharacters(in: .whitespaces)
        }
        headers = collected

        let contentLength = Int(collected["content-length"] ?? "") ?? 0
        let bodyStart = headerEnd.upperBound
        let available = data.count - (bodyStart - data.startIndex)
        guard available >= contentLength else { return nil }

        body = contentLength > 0
            ? data.subdata(in: bodyStart..<(bodyStart + contentLength))
            : Data()
    }

    private static func parseQuery(_ raw: String) -> [String: String] {
        var result: [String: String] = [:]
        for pair in raw.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let rawKey = kv.first else { continue }
            let key = decode(String(rawKey))
            let value = kv.count > 1 ? decode(String(kv[1])) : ""
            guard !key.isEmpty else { continue }
            result[key] = value
        }
        return result
    }

    private static func decode(_ value: String) -> String {
        value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
            ?? value.replacingOccurrences(of: "+", with: " ")
    }
}
