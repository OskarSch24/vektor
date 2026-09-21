import Cocoa
import Network
import UniformTypeIdentifiers
import WebKit

// MARK: - Constants

enum AppConfig {
    static let bundleName = "Vektor"
    // Stable on-disk identity: existing projects, API credentials and the
    // unpacked browser extension must survive a display-name change.
    static let storageDirectoryName = "Database Studio"
    static let version = "1.0.0"
    static let graphExtensions = ["graph", "json"]
    static let openExtensions = [
        "graph", "json", "amqrun", "jsonl", "ndjson", "csv", "tsv",
        "xlsx", "xlsm", "sqlite", "sqlite2", "sqlite3", "db", "db3",
        "rdb", "aof",
        "yaml", "yml", "xml", "toml", "geojson", "parquet", "arrow", "feather", "ipc", "duckdb", "dbconnection",
    ]

    /// `.graph` has no registered UTI, so one is derived from the extension and
    /// falls back to plain JSON if the system declines to mint it.
    static var graphContentTypes: [UTType] {
        graphExtensions.compactMap { UTType(filenameExtension: $0) }.isEmpty
            ? [.json]
            : graphExtensions.compactMap { UTType(filenameExtension: $0) }
    }
    static var openContentTypes: [UTType] {
        let types = openExtensions.compactMap {
            UTType(filenameExtension: $0)
                ?? UTType(tag: $0, tagClass: .filenameExtension, conformingTo: .data)
        }
        return types.isEmpty ? [.data] : types
    }
    static let settingsFileName = "settings.json"
    static let defaultIngestPort: UInt16 = 8787
    static let browserExtensionDirectoryName = "Browser Extension"

    /// Set by the LaunchAgent, which starts the app at login purely to keep the
    /// ingest server reachable. In this mode there is no dock icon and no
    /// window until the user actually asks for one — converting a page must not
    /// depend on somebody having opened the app first.
    static let launchedInBackground = CommandLine.arguments.contains("--background")

    /// Ceilings for `files.readFolder`. A coordination folder holds one small
    /// note per record — a few kilobytes each, a few hundred of them in a busy
    /// project. These bounds are wide enough for that and narrow enough that
    /// pointing the picker at a home directory fails instead of reading it.
    static let maxFolderFiles = 5000
    static let maxFolderFileBytes = 1_048_576

    /// The read/write API for other tools, separate from the extension's
    /// ingest endpoint. Its port and token are published here so a client — the
    /// MCP server above all — needs no configuration.
    static let apiDescriptorFileName = "api.json"
    static let defaultApiPort: UInt16 = 8793
    static let apiEnabledKey = "com.databasestudio.api.enabled"
    static let apiPortKey = "com.databasestudio.api.port"
    static let apiAllowWritesKey = "com.databasestudio.api.allowWrites.graph"
    static let apiAllowWritesSQLiteKey = "com.databasestudio.api.allowWrites.sqlite"
    static let apiAllowWritesVaultKey = "com.databasestudio.api.allowWrites.vault"
    static let apiMigrationKey = "com.databasestudio.api.migrated.v1"

    static let connectionsDefaultsKey = "com.databasestudio.redis.connections"
    static let connectionsMigrationKey = "com.databasestudio.redis.connectionsMigrated.v1"
    static let projectsDefaultsKey = "com.databasestudio.projectPaths"


    /// Where yt-dlp and ffmpeg usually live. `which` alone is not enough: an app
    /// launched from Finder inherits a bare PATH without Homebrew in it.
    static let toolSearchPaths = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/opt/local/bin",
        NSHomeDirectory() + "/.local/bin",
    ]

    static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(storageDirectoryName, isDirectory: true)
    }

    static var legacyGraphSettingsURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Graph Studio", isDirectory: true)
            .appendingPathComponent(settingsFileName)
    }

    static var localRedisDirectory: URL {
        supportDirectory.appendingPathComponent("Local Store", isDirectory: true)
    }

    /// Source for the one-time, atomic local-store migration.
    static var legacyLocalRedisDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Vault Studio", isDirectory: true)
            .appendingPathComponent("Local Store", isDirectory: true)
    }

    static var cacheDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(storageDirectoryName, isDirectory: true)
    }

    /// A stable, user-visible copy of the bundled Chrome extension. Chrome
    /// remembers the absolute path of an unpacked extension, so pointing it at
    /// the version inside the .app bundle would make updates and reinstalls
    /// needlessly fragile.
    static var browserExtensionDirectory: URL {
        supportDirectory.appendingPathComponent(browserExtensionDirectoryName, isDirectory: true)
    }
}

// MARK: - Staged files

/// Holds files the web view is about to fetch over the `app://` scheme. Audio
/// tracks reach the renderer this way instead of as base64 in a JavaScript
/// string, which for a one-hour podcast would cost several hundred megabytes of
/// string memory.
final class StagedFileStore {
    static let shared = StagedFileStore()

    private var entries: [String: URL] = [:]
    private let lock = NSLock()

    func stage(_ url: URL) -> String {
        let token = UUID().uuidString
        lock.lock()
        entries[token] = url
        lock.unlock()
        return token
    }

    func url(for token: String) -> URL? {
        lock.lock()
        defer { lock.unlock() }
        return entries[token]
    }
}

// MARK: - External tools

enum Tools {
    /// Resolves a binary by name, searching the usual install locations first.
    static func locate(_ name: String) -> String? {
        for directory in AppConfig.toolSearchPaths {
            let candidate = (directory as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    struct Result {
        let status: Int32
        let standardOutput: String
        let standardError: String
    }

    /// Runs a tool to completion. Both pipes are drained on background queues:
    /// reading them in sequence deadlocks as soon as one fills its 64 kB buffer
    /// while the process is still writing to the other.
    @discardableResult
    static func run(_ executable: String, _ arguments: [String], timeout: TimeInterval = 3600) throws -> Result {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = AppConfig.toolSearchPaths.joined(separator: ":")
        process.environment = environment

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        var outputData = Data()
        var errorData = Data()
        let collector = DispatchQueue(label: "databasestudio.tool.output")
        let group = DispatchGroup()

        for (pipe, isError) in [(outputPipe, false), (errorPipe, true)] {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                collector.sync {
                    if isError { errorData = data } else { outputData = data }
                }
                group.leave()
            }
        }

        try process.run()

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            throw NativeError("Zeitüberschreitung nach \(Int(timeout)) s: \(executable)")
        }

        group.wait()

        return Result(
            status: process.terminationStatus,
            standardOutput: String(data: outputData, encoding: .utf8) ?? "",
            standardError: String(data: errorData, encoding: .utf8) ?? ""
        )
    }
}

struct NativeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - Saved Redis connections

struct SavedConnection {
    var id: String
    var name: String
    var host: String
    var port: Int
    var database: Int
    var username: String

    init(id: String, name: String, host: String, port: Int, database: Int, username: String) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.database = database
        self.username = username
    }

    init?(stored: [String: Any]) {
        guard let id = stored["id"] as? String, let host = stored["host"] as? String else { return nil }
        self.id = id
        self.name = stored["name"] as? String ?? host
        self.host = host
        self.port = stored["port"] as? Int ?? 6379
        self.database = stored["db"] as? Int ?? 0
        self.username = stored["username"] as? String ?? ""
    }

    var stored: [String: Any] {
        ["id": id, "name": name, "host": host, "port": port, "db": database, "username": username]
    }

    var json: [String: Any] {
        [
            "id": id, "name": name, "host": host, "port": port,
            "db": database, "username": username,
            "hasPassword": !Keychain.password(for: id).isEmpty,
        ]
    }
}

final class ConnectionRegistry {
    private static let legacyDomain = "com.oskarschiermeister.vaultstudio"
    private static let legacyKey = "com.vaultstudio.connections"

    private var storage: [SavedConnection]
    private let lock = NSLock()

    var entries: [SavedConnection] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }

    init() {
        let current = UserDefaults.standard.array(forKey: AppConfig.connectionsDefaultsKey)
            as? [[String: Any]] ?? []
        var collected = current.compactMap(SavedConnection.init(stored:))
        let legacy = UserDefaults.standard
            .persistentDomain(forName: Self.legacyDomain)?[Self.legacyKey]
            as? [[String: Any]] ?? []
        let legacyEntries = legacy.compactMap(SavedConnection.init(stored:))

        if !UserDefaults.standard.bool(forKey: AppConfig.connectionsMigrationKey) {
            for entry in legacyEntries
                where !collected.contains(where: { $0.id == entry.id }) {
                collected.append(entry)
            }
            UserDefaults.standard.set(true, forKey: AppConfig.connectionsMigrationKey)
        }

        storage = collected
        persist(collected)
        // Retry credentials independently of the defaults migration marker:
        // Keychain may have been locked during an earlier background launch.
        var credentialEntries: [String: SavedConnection] = [:]
        for entry in collected + legacyEntries { credentialEntries[entry.id] = entry }
        for entry in credentialEntries.values {
            if !Keychain.migrateLegacyPasswordIfNeeded(for: entry.id) {
                NSLog("Redis-Passwort für \(entry.id) konnte nicht vollständig migriert werden.")
            }
        }
    }

    func upsert(_ entry: SavedConnection, password: String?) {
        lock.lock()
        if let index = storage.firstIndex(where: { $0.id == entry.id }) {
            storage[index] = entry
        } else {
            storage.append(entry)
        }
        let snapshot = storage
        lock.unlock()

        if let password { Keychain.save(password: password, for: entry.id) }
        persist(snapshot)
    }

    func remove(id: String) {
        lock.lock()
        storage.removeAll { $0.id == id }
        let snapshot = storage
        lock.unlock()
        Keychain.delete(account: id)
        persist(snapshot)
    }

    private func persist(_ entries: [SavedConnection]) {
        UserDefaults.standard.set(entries.map(\.stored), forKey: AppConfig.connectionsDefaultsKey)
    }
}

// MARK: - Ingest server

/// The state the HTTP endpoints report. The renderer pushes it whenever it
/// changes, so a request can be answered from memory instead of waiting on a
/// round trip into JavaScript.
struct ServerSnapshot {
    var graphName: String = ""
    var graphPath: String = ""
    var nodeCount: Int = 0
    /// Tokens the models have reported so far — a measurement, not a balance.
    var tokensUsed: Int = 0
    var targets: [[String: Any]] = []
    var defaultTargetId: String = ""
}

/**
 A minimal HTTP/1.1 server on the loopback interface — the seam the Chrome
 extension talks through.

 It answers four things and nothing else: a status probe, the list of targets,
 an ingest POST, and the CORS preflight for those. Keeping the surface this
 small is deliberate: it listens on a port any local process can reach, so every
 additional route would be another thing to reason about.
 */
final class IngestServer {
    private static let activeClientWindow: TimeInterval = 15
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "databasestudio.ingest")
    private var snapshot = ServerSnapshot()
    private let snapshotLock = NSLock()
    private var clientLastSeen: [String: Date] = [:]
    private var lastClientSeenAt: Date?
    private var lastIngestAt: Date?
    private var requestCount = 0
    private var startError: String?
    private let telemetryLock = NSLock()

    /// Called on the main queue with the raw JSON body of an accepted ingest.
    var onPayload: ((Data) -> Void)?

    /// Supplies the project folders and the graph files in them. Read on demand
    /// rather than pushed, so the extension always sees the folders as they are
    /// on disk right now.
    var projectsProvider: (() -> [[String: Any]])?

    private(set) var port: UInt16 = AppConfig.defaultIngestPort
    var isRunning: Bool { listener?.state == .ready }

    /// Renderer-only diagnostics. The public HTTP response shapes deliberately
    /// stay unchanged; this data only powers the honest "ready" vs "connected"
    /// distinction inside Database Studio.
    func statusPayload() -> [String: Any] {
        telemetryLock.lock()
        defer { telemetryLock.unlock() }

        let now = Date()
        clientLastSeen = clientLastSeen.filter {
            now.timeIntervalSince($0.value) <= Self.activeClientWindow
        }

        return [
            "running": isRunning,
            "port": Int(port),
            "clients": clientLastSeen.keys.sorted(),
            "lastSeenAt": lastClientSeenAt.map(Self.iso8601) ?? NSNull(),
            "lastIngestAt": lastIngestAt.map(Self.iso8601) ?? NSNull(),
            "requestCount": requestCount,
            "error": startError ?? NSNull(),
        ]
    }

    func updateSnapshot(_ update: (inout ServerSnapshot) -> Void) {
        snapshotLock.lock()
        update(&snapshot)
        snapshotLock.unlock()
    }

    private func readSnapshot() -> ServerSnapshot {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        return snapshot
    }

    func start(port requested: UInt16) throws {
        if isRunning && requested == port { return }
        stop()
        setStartError(nil)

        guard let nwPort = NWEndpoint.Port(rawValue: requested) else {
            throw NativeError("Ungültiger Port: \(requested)")
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        // Binding to the loopback address rather than to all interfaces means
        // nothing outside this machine can reach the endpoint at all.
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

        // A port already in use fails asynchronously; without this wait the
        // renderer would be told the server started when it did not.
        if ready.wait(timeout: .now() + 2) == .timedOut {
            stop()
            let message = "Port \(requested) antwortet nicht."
            setStartError(message)
            throw NativeError(message)
        }
        if let error = startError {
            stop()
            let message = "Port \(requested) ist belegt: \(error.localizedDescription)"
            setStartError(message)
            throw NativeError(message)
        }
        setStartError(nil)
    }

    func stop() {
        listener?.cancel()
        listener = nil
        setStartError(nil)
    }

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

            guard let request = HTTPRequest(accumulated) else {
                // Headers or body still incomplete — keep reading. A payload
                // with a long article in it does not arrive in one segment.
                if accumulated.count > 32 * 1024 * 1024 {
                    self.send(connection, status: 413, json: ["error": "Payload zu groß"])
                    return
                }
                self.receive(connection, buffer: accumulated)
                return
            }

            self.handle(request, on: connection)
        }
    }

    private func handle(_ request: HTTPRequest, on connection: NWConnection) {
        recordClientActivity(for: request)

        if request.method == "OPTIONS" {
            send(connection, status: 204, body: Data(), contentType: nil)
            return
        }

        switch (request.method, request.path) {
        case ("GET", "/status"):
            let state = readSnapshot()
            send(connection, status: 200, json: [
                "ok": true,
                "app": AppConfig.bundleName,
                "version": AppConfig.version,
                "graphName": state.graphName,
                "graphPath": state.graphPath,
                "nodeCount": state.nodeCount,
                "tokensUsed": state.tokensUsed,
            ])

        case ("GET", "/projects"):
            let state = readSnapshot()
            send(connection, status: 200, json: [
                "projects": projectsProvider?() ?? [],
                "openGraph": state.graphName,
                "nodeCount": state.nodeCount,
                "targets": state.targets,
                "defaultTargetId": state.defaultTargetId,
            ])

        case ("GET", "/targets"):
            let state = readSnapshot()
            send(connection, status: 200, json: [
                "targets": state.targets,
                "defaultTargetId": state.defaultTargetId,
            ])

        case ("POST", "/ingest"):
            guard
                let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                let url = object["url"] as? String,
                !url.isEmpty
            else {
                send(connection, status: 400, json: ["error": "Ungültige Nutzlast: url fehlt"])
                return
            }

            let body = request.body
            recordAcceptedIngest()
            DispatchQueue.main.async { [weak self] in
                self?.onPayload?(body)
            }
            send(connection, status: 202, json: ["accepted": true, "url": url])

        default:
            send(connection, status: 404, json: ["error": "Unbekannter Pfad"])
        }
    }

    private func recordClientActivity(for request: HTTPRequest) {
        let declaredClient = request.headers["x-database-studio-client"]
        guard
            let client = declaredClient,
            client.hasPrefix("Database Studio Extension/"),
            client.count <= 128
        else { return }
        let now = Date()
        telemetryLock.lock()
        clientLastSeen[client] = now
        lastClientSeenAt = now
        requestCount += 1
        telemetryLock.unlock()
    }

    private func recordAcceptedIngest() {
        telemetryLock.lock()
        lastIngestAt = Date()
        telemetryLock.unlock()
    }

    private func setStartError(_ message: String?) {
        telemetryLock.lock()
        startError = message
        telemetryLock.unlock()
    }

    private static func iso8601(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func send(_ connection: NWConnection, status: Int, json: [String: Any]) {
        let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        send(connection, status: status, body: body, contentType: "application/json; charset=utf-8")
    }

    private func send(_ connection: NWConnection, status: Int, body: Data, contentType: String?) {
        var header = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        header += "Content-Length: \(body.count)\r\n"
        if let contentType { header += "Content-Type: \(contentType)\r\n" }
        // The caller is a Chrome extension, whose origin is a random id per
        // install; there is nothing stable to allowlist against.
        header += "Access-Control-Allow-Origin: *\r\n"
        header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        header += "Access-Control-Allow-Headers: Content-Type, X-Database-Studio-Client\r\n"
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
        case 202: return "Accepted"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 413: return "Payload Too Large"
        default: return "Error"
        }
    }
}

/// Just enough HTTP parsing for the four routes above.
struct HTTPRequest {
    let method: String
    let path: String
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
        path = requestLine[1].components(separatedBy: "?")[0]

        var parsedHeaders: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            parsedHeaders[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        headers = parsedHeaders
        let contentLength = Int(parsedHeaders["content-length"] ?? "0") ?? 0

        let bodyStart = headerEnd.upperBound
        let available = data.count - (bodyStart - data.startIndex)
        // Signalling "not a request yet" makes the caller keep reading until the
        // declared body has actually arrived.
        guard available >= contentLength else { return nil }

        body = contentLength > 0
            ? data.subdata(in: bodyStart..<(bodyStart + contentLength))
            : Data()
    }
}

// MARK: - Asset serving

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            fail(task, message: "Keine URL")
            return
        }

        // `app://localhost/staged/<token>` hands out a file the host prepared.
        if url.path.hasPrefix("/staged/") {
            let token = String(url.path.dropFirst("/staged/".count))
            guard let fileURL = StagedFileStore.shared.url(for: token),
                  let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
                fail(task, message: "Datei nicht mehr verfügbar")
                return
            }
            send(data: data, mimeType: Self.mimeType(for: fileURL.pathExtension), url: url, task: task)
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        let fileURL = root.appendingPathComponent(path)
        // Refuse anything that resolves outside the bundled assets, so a
        // crafted asset URL cannot read arbitrary files.
        let rootPath = root.standardizedFileURL.path
        let candidatePath = fileURL.standardizedFileURL.path
        guard (candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/")),
              let data = try? Data(contentsOf: fileURL) else {
            fail(task, message: "Nicht gefunden: \(path)")
            return
        }

        send(data: data, mimeType: Self.mimeType(for: fileURL.pathExtension), url: url, task: task)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func send(data: Data, mimeType: String, url: URL, task: WKURLSchemeTask) {
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType,
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*",
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, message: String) {
        task.didFailWithError(NativeError(message))
    }

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "graph": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "wasm": return "application/wasm"
        case "ogg", "opus": return "audio/ogg"
        case "m4a": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Project scanning

/**
 Project folders: a directory the user added, scanned for the graph, tabular,
 SQLite and Redis file types Database Studio can represent. Phase-X run files
 are classified before ordinary JSON because they share the `.json` suffix.

 The scan is bounded in three ways — depth, file budget, and a skip list for
 directories that hold tens of thousands of files and no graph anybody asked to
 see. Without those, adding a home directory would hang the app.
 */
enum ProjectScanner {
    static let ignoredDirectories: Set<String> = [
        "node_modules", ".git", ".svn", ".hg", "Library", "DerivedData",
        "__pycache__", ".Trash", ".venv", "venv", "dist", "build",
    ]
    static let maxDepth = 12
    static let maxFiles = 20_000
    private static let sqliteMagic = Data("SQLite format 3\0".utf8)
    private static let zipMagic = Data([0x50, 0x4B, 0x03, 0x04])

    static func projectFileType(_ url: URL) -> String? {
        let name = url.lastPathComponent.lowercased()
        let ext = url.pathExtension.lowercased()
        if ext == "amqrun" || name.hasSuffix(".amqrun.json") {
            return "phase-x-run"
        }
        // Redis 7 multipart AOF components are one logical database and are
        // exposed by VaultProjectScanner through their manifest. Showing its
        // base/increment parts as separate sources would invite users to open
        // an incomplete state.
        if name.range(
            of: #"\.aof\.\d+\.(base\.rdb|incr\.aof)$"#,
            options: .regularExpression
        ) != nil {
            return nil
        }
        if ext == "graph" { return "graph" }
        if ext == "dbconnection" || name.hasSuffix(".dbconnection.json") { return "connection" }
        if ["yaml", "yml", "xml", "toml", "geojson"].contains(ext) { return "document" }
        if ["arrow", "feather", "ipc"].contains(ext) { return "arrow" }
        if ext == "parquet" { return "parquet" }
        if ext == "duckdb" { return "duckdb" }
        if ["sqlite", "sqlite2", "sqlite3", "db", "db3"].contains(ext) {
            guard let head = fileHead(url, count: sqliteMagic.count) else { return nil }
            return head.isEmpty || head == sqliteMagic ? "sqlite" : nil
        }
        if ["csv", "tsv"].contains(ext) { return "csv" }
        if ["jsonl", "ndjson"].contains(ext) { return "json-table" }
        if ext == "json" {
            guard let head = fileHead(url, count: 4096) else { return nil }
            let text = String(decoding: head, as: UTF8.self)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF} \t\r\n"))
            return text.isEmpty ? nil : "json-table"
        }
        if ["xlsx", "xlsm"].contains(ext) {
            return fileHead(url, count: zipMagic.count) == zipMagic ? "excel" : nil
        }
        if ext == "rdb" {
            guard let head = fileHead(url, count: 9), head.count == 9 else { return nil }
            let signature = String(decoding: head, as: UTF8.self)
            return signature.hasPrefix("REDIS") && signature.dropFirst(5).allSatisfy(\.isNumber)
                ? "redis-rdb" : nil
        }
        if ext == "aof" || name.hasSuffix(".aof.manifest") { return "redis-aof" }
        return nil
    }

    private static func fileHead(_ url: URL, count: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        return try? handle.read(upToCount: count)
    }

    static func hasPendingWal(for url: URL) -> Bool {
        let wal = URL(fileURLWithPath: url.path + "-wal")
        return ((try? wal.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
    }

    private static let resourceKeys: Set<URLResourceKey> = [
        .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey,
        .fileSizeKey, .contentModificationDateKey,
    ]

    private struct ScanState {
        var visitedFiles = 0
        var visibleFileCount = 0
        var redisFiles: [VaultProjectScanner.FileEntry] = []
        var truncated = false
    }

    /// One depth-first walk feeds both the project tree and Redis artifact
    /// grouping. The budget counts every regular file we inspect, not only a
    /// recognized source, so a folder full of unrelated files stays bounded.
    ///
    /// The two inclusion flags preserve the scanners' existing skip lists. A
    /// directory such as `venv` can be omitted from the Explorer while still
    /// being searched for Redis snapshots, without reading its parent twice.
    private static func scan(_ directory: URL, depth: Int = 0,
                             includeProjectFiles: Bool = true,
                             includeRedisFiles: Bool = true,
                             state: inout ScanState) -> [[String: Any]] {
        guard depth < maxDepth, state.visitedFiles < maxFiles else {
            if state.visitedFiles >= maxFiles { state.truncated = true }
            return []
        }

        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(resourceKeys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )) ?? []

        var folders: [[String: Any]] = []
        var files: [[String: Any]] = []

        for url in contents {
            guard state.visitedFiles < maxFiles else {
                state.truncated = true
                break
            }
            let values = try? url.resourceValues(forKeys: resourceKeys)

            // Following project symlinks would let a narrow project scan escape
            // into an unrelated tree and can also create cycles.
            if values?.isSymbolicLink == true { continue }

            if values?.isDirectory == true {
                let projectDirectory = includeProjectFiles
                    && !ignoredDirectories.contains(url.lastPathComponent)
                let redisDirectory = includeRedisFiles
                    && VaultProjectScanner.shouldTraverseDirectory(named: url.lastPathComponent)
                guard projectDirectory || redisDirectory else { continue }

                let children = scan(
                    url,
                    depth: depth + 1,
                    includeProjectFiles: projectDirectory,
                    includeRedisFiles: redisDirectory,
                    state: &state
                )
                if projectDirectory, !children.isEmpty {
                    folders.append([
                        "kind": "folder",
                        "id": url.path,
                        "name": url.lastPathComponent,
                        "path": url.path,
                        "children": children,
                    ])
                }
                continue
            }

            guard values?.isRegularFile == true else { continue }
            state.visitedFiles += 1
            if state.visitedFiles >= maxFiles { state.truncated = true }

            if includeRedisFiles, VaultProjectScanner.isArtifactFile(url) {
                state.redisFiles.append(VaultProjectScanner.FileEntry(
                    url: url,
                    size: Int64(values?.fileSize ?? 0),
                    modified: values?.contentModificationDate ?? .distantPast
                ))
            }

            guard includeProjectFiles, let fileType = projectFileType(url) else { continue }
            state.visibleFileCount += 1
            var payload: [String: Any] = [
                "kind": "file",
                "fileType": fileType,
                "id": url.path,
                "name": url.lastPathComponent,
                "path": url.path,
                "size": values?.fileSize ?? 0,
                "modified": Int((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000),
            ]
            if fileType == "sqlite" { payload["pendingWal"] = hasPendingWal(for: url) }
            files.append(payload)
        }

        // Folders first, then files, each alphabetically — the order a file
        // browser uses, so the tree needs no explanation.
        let byName: ([String: Any], [String: Any]) -> Bool = { left, right in
            let a = (left["name"] as? String ?? "").lowercased()
            let b = (right["name"] as? String ?? "").lowercased()
            return a < b
        }
        return folders.sorted(by: byName) + files.sorted(by: byName)
    }

    /// The graph files below a project, flattened — the extension shows them in
    /// one list, where the folder they sit in matters less than their name.
    static func graphFiles(in nodes: [[String: Any]]) -> [[String: Any]] {
        var files: [[String: Any]] = []
        for node in nodes {
            if node["kind"] as? String == "file", node["fileType"] as? String == "graph" {
                files.append([
                    "path": node["path"] as? String ?? "",
                    "name": node["name"] as? String ?? "",
                    "size": node["size"] as? Int ?? 0,
                ])
            } else if let children = node["children"] as? [[String: Any]] {
                files.append(contentsOf: graphFiles(in: children))
            }
        }
        return files
    }

    static func project(at url: URL) -> [String: Any] {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)

        guard exists, isDirectory.boolValue else {
            return [
                "id": url.path,
                "name": url.lastPathComponent,
                "path": url.path,
                "children": [],
                "fileCount": 0,
                "redisDatabases": [],
                "redisDatabaseCount": 0,
                "databases": [],
                "databaseCount": 0,
                "error": "Ordner nicht gefunden",
            ]
        }

        var state = ScanState()
        let children = scan(url, state: &state)
        let redisResult = VaultProjectScanner.artifacts(
            in: url,
            files: state.redisFiles,
            truncated: state.truncated
        )
        let redisDatabases = redisResult.artifacts.map(\.json)
        let redisDatabaseCount = redisResult.artifacts.count
        return [
            "id": url.path,
            "name": url.lastPathComponent,
            "path": url.path,
            "children": children,
            "fileCount": state.visibleFileCount,
            // Both names are intentional: the unified project rail consumes
            // the prefixed fields, while the preserved Vault project view can
            // keep consuming its original `databases` contract.
            "redisDatabases": redisDatabases,
            "redisDatabaseCount": redisDatabaseCount,
            "redisTruncated": redisResult.truncated,
            "databases": redisDatabases,
            "databaseCount": redisDatabaseCount,
            "truncated": redisResult.truncated,
        ]
    }
}

/// The added folders, kept across launches.
final class ProjectRegistry {
    private static let defaultsKey = AppConfig.projectsDefaultsKey
    private static let migrationKey = "com.databasestudio.legacyProjectPathsMigrated.v1"
    private static let sharedDefaults = UserDefaults(suiteName: "com.oskarschiermeister.amq.phase-x")
    private static let sharedDefaultsKey = "projectPaths"
    private static let legacySources: [(domain: String, key: String)] = [
        ("com.oskarschiermeister.sqlitestudio", "com.sqlitestudio.projectPaths"),
        ("com.oskarschiermeister.graphstudio", "com.graphstudio.projectPaths"),
        ("com.oskarschiermeister.vaultstudio", "com.vaultstudio.projectPaths"),
    ]

    private(set) var paths: [String]
    private var cachedProjects: [String: [String: Any]] = [:]
    private let cacheLock = NSLock()

    init() {
        let local = UserDefaults.standard.stringArray(forKey: ProjectRegistry.defaultsKey) ?? []
        var initial = local

        // A new bundle identifier gets a new UserDefaults domain. Import each
        // legacy domain exactly once; otherwise a folder deliberately removed in
        // Database Studio would reappear from an old app on the next launch.
        if !UserDefaults.standard.bool(forKey: ProjectRegistry.migrationKey) {
            initial.append(contentsOf: ProjectRegistry.sharedDefaults?.stringArray(
                forKey: ProjectRegistry.sharedDefaultsKey
            ) ?? [])
            for source in ProjectRegistry.legacySources {
                let domain = UserDefaults.standard.persistentDomain(forName: source.domain)
                initial.append(contentsOf: domain?[source.key] as? [String] ?? [])
            }
            UserDefaults.standard.set(true, forKey: ProjectRegistry.migrationKey)
        }

        // A genuinely fresh install still gets the known AMQ checkout when it
        // exists. Missing paths imported above remain visible so the UI can tell
        // the user that a folder moved instead of silently forgetting it.
        if initial.isEmpty {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let candidates = [
                home.appendingPathComponent("dev/ask-more-questions", isDirectory: true),
                home.appendingPathComponent("Ask More Questions", isDirectory: true),
            ]
            for candidate in candidates {
                var isDirectory: ObjCBool = false
                let path = candidate.standardizedFileURL.path
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
                   isDirectory.boolValue {
                    initial.append(path)
                }
            }
        }

        paths = ProjectRegistry.uniqueExistingPaths(initial)
        persist()
    }

    func add(_ path: String) {
        guard !paths.contains(path) else { return }
        paths.append(path)
        persist()
    }

    func remove(_ path: String) {
        paths.removeAll { $0 == path }
        cacheLock.lock()
        cachedProjects.removeValue(forKey: path)
        cacheLock.unlock()
        persist()
    }

    /// Returns the saved roots immediately. Their trees are filled by
    /// concurrent `refresh` calls from the renderer, so restoring several
    /// large projects never leaves the Explorer looking empty for a minute.
    func listedProjects() -> [[String: Any]] {
        cacheLock.lock()
        let cache = cachedProjects
        cacheLock.unlock()
        return paths.map { cache[$0] ?? Self.projectSummary(path: $0) }
    }

    /// Scans one root and publishes the result to both the Explorer and the
    /// extension cache. Calls for different roots may run concurrently.
    func scan(_ path: String) -> [String: Any] {
        let project = ProjectScanner.project(at: URL(fileURLWithPath: path))
        cacheLock.lock()
        cachedProjects[path] = project
        cacheLock.unlock()
        return project
    }

    /// The browser popup only needs project identities and graph targets. It
    /// must never perform a synchronous disk crawl inside a four-second fetch.
    func extensionProjects() -> [[String: Any]] {
        listedProjects().map { project in
            let path = project["path"] as? String ?? ""
            let children = project["children"] as? [[String: Any]] ?? []
            return [
                "id": project["id"] as? String ?? path,
                "name": project["name"] as? String ?? path,
                "path": path,
                "graphs": ProjectScanner.graphFiles(in: children),
            ]
        }
    }

    private func persist() {
        UserDefaults.standard.set(paths, forKey: ProjectRegistry.defaultsKey)
        // The legacy shared suite is import-only. Writing the unified list back
        // would make a folder removed here disappear from Graph/Vault Studio,
        // and would expose SQLite-only folders in those older apps.
    }

    private static func projectSummary(path: String) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        var summary: [String: Any] = [
            "id": path,
            "name": url.lastPathComponent,
            "path": path,
            "children": [],
            "fileCount": 0,
            "redisDatabases": [],
            "redisDatabaseCount": 0,
            "databases": [],
            "databaseCount": 0,
            "truncated": false,
        ]
        if !exists || !isDirectory.boolValue {
            summary["error"] = "Ordner nicht gefunden"
        }
        return summary
    }

    private static func uniqueExistingPaths(_ candidates: [String]) -> [String] {
        var seen = Set<String>()
        return candidates.compactMap { raw in
            let path = URL(fileURLWithPath: raw).standardizedFileURL.path
            guard !path.isEmpty, !seen.contains(path) else { return nil }
            seen.insert(path)
            return path
        }
    }
}

// MARK: - Page rendering

/**
 Loads a page in an off-screen WebKit view and returns the DOM after the page
 has built itself.

 A plain fetch sees what the server sends. For a site that assembles its content
 in the browser — CodeWiki ships 44 kB of application and not one sentence of
 documentation — that is nothing. Rendering it is the only honest way to read
 such a page from an address, and the app already carries the engine to do it.

 Pages are rendered one at a time in a view with a non-persistent data store,
 so nothing a site sets survives the request or leaks into the next one.
 */
final class PageRenderer: NSObject, WKNavigationDelegate {
    static let shared = PageRenderer()

    /// Upper bound for one page; a site that never settles is cut off here and
    /// whatever it has drawn by then is taken.
    static let timeout: TimeInterval = 25
    /// How long the visible text has to stay unchanged to count as settled.
    static let settleInterval: TimeInterval = 0.8
    /// A page showing almost no text is not settled, it is loading — a spinner
    /// caption is perfectly stable. Such a page gets at least this long.
    static let minimumWaitWhileEmpty: TimeInterval = 8
    static let emptyTextThreshold = 200

    private var webView: WKWebView?
    /// The navigation currently being rendered. Delegate callbacks for any
    /// other navigation — a cancelled predecessor, a stray redirect — are noise
    /// and are ignored. Confusing them for the current one is what made a long
    /// run collapse into empty pages after the timing shifted.
    private var currentNavigation: WKNavigation?
    private var generation = 0
    private var completion: ((String?) -> Void)?
    private var lastLength = -1
    private var stableTicks = 0
    private var startedAt = Date()
    private let oneAtATime = DispatchSemaphore(value: 1)

    /// Blocks the calling (background) thread until the page has rendered.
    /// A page that comes back empty is retried once in a fresh web view.
    func render(_ url: URL) -> String? {
        oneAtATime.wait()
        defer { oneAtATime.signal() }

        if let html = renderOnce(url), !html.isEmpty { return html }

        // Nothing usable: the view may be wedged. Replace it and try once more.
        DispatchQueue.main.sync { self.discardWebView() }
        return renderOnce(url)
    }

    private func renderOnce(_ url: URL) -> String? {
        var result: String?
        let done = DispatchSemaphore(value: 0)
        var myGeneration = 0

        DispatchQueue.main.async {
            self.generation += 1
            myGeneration = self.generation
            self.begin(url, generation: myGeneration) { html in
                result = html
                done.signal()
            }
        }

        if done.wait(timeout: .now() + PageRenderer.timeout + 5) == .timedOut {
            // The main-thread deadline should have fired; if it did not, close
            // this request out so the caller is never left hanging.
            DispatchQueue.main.async {
                if self.generation == myGeneration { self.finish(nil, generation: myGeneration) }
            }
            _ = done.wait(timeout: .now() + 2)
        }
        return result
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // Sites lay themselves out for a viewport; give them a normal one.
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 900),
                             configuration: configuration)
        view.navigationDelegate = self
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 DatabaseStudio/\(AppConfig.version)"
        return view
    }

    private func discardWebView() {
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
    }

    private func begin(_ url: URL, generation: Int, completion: @escaping (String?) -> Void) {
        self.completion = completion
        lastLength = -1
        stableTicks = 0
        startedAt = Date()

        if webView == nil { webView = makeWebView() }

        var request = URLRequest(url: url)
        request.timeoutInterval = PageRenderer.timeout
        currentNavigation = webView?.load(request)

        // Hard deadline for this generation: take what is there rather than
        // nothing. A later generation ignores it.
        DispatchQueue.main.asyncAfter(deadline: .now() + PageRenderer.timeout) { [weak self] in
            guard let self, self.generation == generation, self.completion != nil else { return }
            self.snapshot(generation: generation)
        }
    }

    private func isCurrent(_ navigation: WKNavigation?) -> Bool {
        navigation != nil && navigation == currentNavigation
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isCurrent(navigation) else { return }
        // "Loaded" is not "rendered": the app inside still has to fetch its data
        // and draw. Poll the text length until it stops growing.
        pollUntilSettled(generation: generation)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard isCurrent(navigation) else { return }
        finish(nil, generation: generation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard isCurrent(navigation) else { return }
        finish(nil, generation: generation)
    }

    private func pollUntilSettled(generation: Int) {
        guard self.generation == generation, completion != nil else { return }

        webView?.evaluateJavaScript("document.body ? document.body.innerText.length : 0") { [weak self] value, _ in
            guard let self, self.generation == generation, self.completion != nil else { return }
            let length = value as? Int ?? 0

            if length == self.lastLength && length > 0 {
                self.stableTicks += 1
            } else {
                self.stableTicks = 0
                self.lastLength = length
            }

            // Two unchanged readings in a row: the page has stopped changing —
            // unless what is on it is a loading caption, which never changes
            // either. A near-empty page keeps waiting up to the minimum.
            let elapsed = Date().timeIntervalSince(self.startedAt)
            let substantial = length >= PageRenderer.emptyTextThreshold
            if self.stableTicks >= 2 && (substantial || elapsed >= PageRenderer.minimumWaitWhileEmpty) {
                self.snapshot(generation: generation)
                return
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + PageRenderer.settleInterval) {
                self.pollUntilSettled(generation: generation)
            }
        }
    }

    private func snapshot(generation: Int) {
        guard self.generation == generation, completion != nil else { return }
        webView?.evaluateJavaScript("document.documentElement.outerHTML") { [weak self] value, _ in
            self?.finish(value as? String, generation: generation)
        }
    }

    private func finish(_ html: String?, generation: Int) {
        guard self.generation == generation, let completion else { return }
        self.completion = nil
        currentNavigation = nil
        // Stop, but do not navigate anywhere else: a follow-up load is a new
        // navigation whose callbacks would arrive during the next request.
        webView?.stopLoading()
        completion(html)
    }
}

// MARK: - Title bar dragging

/**
 The window has a full-size content view, so the web app paints its own title
 bar and there is no native one left to grab. This transparent view sits over
 that strip and turns a press into a window drag.

 `-webkit-app-region: drag`, which does this in Electron, has no effect in a
 WKWebView — the web engine there knows nothing about the window. The regions
 that must stay clickable are therefore reported by the page and punched out of
 this view's hit area, so buttons in the title bar keep working.
 */
final class TitleBarDragView: NSView {
    /// Rects the page wants clicks for, in CSS pixels from the view's top left.
    var interactiveRects: [CGRect] = []

    // Matching the web page's coordinate system keeps the reported rects usable
    // without flipping every one of them on arrival.
    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        // Returning nil lets the event fall through to the web view below.
        for rect in interactiveRects where rect.contains(local) { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        // Double-clicking a title bar zooms the window on macOS, unless the user
        // configured otherwise; honouring that setting is cheap.
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window?.performMiniaturize(nil)
            case "None": break
            default: window?.performZoom(nil)
            }
            return
        }
        window?.performDrag(with: event)
    }
}

// MARK: - Site mapping

/**
 Lists the pages a site publishes, so a whole section can be ingested instead of
 one page at a time.

 The addresses come from the site's own sitemap where there is one — that is the
 list the operator maintains for search engines, so it is both the most complete
 and the most polite source. Only when a site publishes none does this fall back
 to reading the links off the starting page.

 This runs in the host rather than the web view because a sitemap is served
 without CORS headers: the renderer is not allowed to read one, the host is.
 */
enum SiteMapper {
    /// Hard ceilings, so pointing this at a large news site cannot run away.
    static let maxSitemaps = 25
    static let maxUrls = 5_000
    static let requestTimeout: TimeInterval = 15

    struct Entry {
        let loc: String
        let lastModified: String?
    }

    static func discover(start: URL, limit: Int) -> [String: Any] {
        guard let host = start.host else {
            return ["urls": [], "via": "none", "sitemaps": [], "truncated": false]
        }

        var sitemapURLs = robotsSitemaps(for: start)
        if sitemapURLs.isEmpty {
            // The conventional locations, tried in the order of how common they are.
            for path in ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/sitemap.xml.gz"] {
                if let candidate = URL(string: path, relativeTo: start)?.absoluteURL {
                    sitemapURLs.append(candidate)
                }
            }
        }

        var seenSitemaps = Set<String>()
        var visitedSitemaps: [String] = []
        var entries: [String: Entry] = [:]
        var queue = sitemapURLs
        var truncated = false

        while !queue.isEmpty, visitedSitemaps.count < maxSitemaps {
            let sitemapURL = queue.removeFirst()
            guard seenSitemaps.insert(sitemapURL.absoluteString).inserted else { continue }
            guard let data = fetch(sitemapURL) else { continue }

            let parsed = SitemapParser.parse(decompressIfNeeded(data, url: sitemapURL))
            if parsed.locations.isEmpty && parsed.nested.isEmpty { continue }
            visitedSitemaps.append(sitemapURL.absoluteString)

            // A sitemap index points at further sitemaps rather than at pages.
            // Those may well live on another host — large sites often serve them
            // from a separate domain — so only the pages they list are filtered
            // by site, not the index itself.
            for nested in parsed.nested {
                if let url = URL(string: nested) { queue.append(url) }
            }

            for entry in parsed.locations {
                guard let url = URL(string: entry.loc), sameSite(url, as: host) else { continue }
                if entries.count >= min(limit, maxUrls) {
                    truncated = true
                    break
                }
                entries[normalise(url)] = Entry(loc: url.absoluteString, lastModified: entry.lastModified)
            }
        }

        var via = "sitemap"
        if entries.isEmpty {
            via = "crawl"
            for url in linksOnPage(start, host: host).prefix(min(limit, maxUrls)) {
                entries[normalise(url)] = Entry(loc: url.absoluteString, lastModified: nil)
            }
        }

        // Always include the page the user started from, even if the sitemap
        // omits it — that is the one address they definitely meant.
        if entries[normalise(start)] == nil && entries.count < min(limit, maxUrls) {
            entries[normalise(start)] = Entry(loc: start.absoluteString, lastModified: nil)
        }

        let sorted = entries.values.sorted { $0.loc < $1.loc }
        return [
            "urls": sorted.map { entry -> [String: Any] in
                var row: [String: Any] = ["url": entry.loc]
                if let lastModified = entry.lastModified { row["lastModified"] = lastModified }
                return row
            },
            "via": entries.isEmpty ? "none" : via,
            "sitemaps": visitedSitemaps,
            "truncated": truncated,
        ]
    }

    /// Fetches one page as text for the extractor in the renderer. When the
    /// server's HTML holds no readable content, the page is rendered instead.
    static func fetchPage(_ url: URL) -> [String: Any]? {
        guard let data = fetch(url), !data.isEmpty else { return nil }
        // Most of the web is UTF-8; ISO-8859-1 covers nearly all of the rest.
        let html = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
        guard let html else { return nil }

        // A large document with almost no text is an application shell. What
        // the user wants is what that application draws, so draw it.
        if data.count > 10_000 && roughTextLength(of: html) < 200,
           let rendered = PageRenderer.shared.render(url) {
            return [
                "html": rendered,
                "url": url.absoluteString,
                "bytes": rendered.utf8.count,
                "rendered": true,
            ]
        }

        return ["html": html, "url": url.absoluteString, "bytes": data.count, "rendered": false]
    }

    /// Visible-text estimate without a DOM: scripts, styles and tags removed.
    private static func roughTextLength(of html: String) -> Int {
        var text = html
        for pattern in ["<script[^>]*>[\\s\\S]*?</script>", "<style[^>]*>[\\s\\S]*?</style>", "<[^>]+>"] {
            text = text.replacingOccurrences(of: pattern, with: " ", options: [.regularExpression, .caseInsensitive])
        }
        return text.split(whereSeparator: { $0.isWhitespace }).reduce(0) { $0 + $1.count }
    }

    // MARK: Sources

    private static func robotsSitemaps(for start: URL) -> [URL] {
        guard
            let robots = URL(string: "/robots.txt", relativeTo: start)?.absoluteURL,
            let data = fetch(robots),
            let text = String(data: data, encoding: .utf8)
        else { return [] }

        return text.components(separatedBy: .newlines).compactMap { line in
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "sitemap" else {
                return nil
            }
            return URL(string: parts[1].trimmingCharacters(in: .whitespaces))
        }
    }

    /// Same-host links on the starting page — the fallback when there is no sitemap.
    private static func linksOnPage(_ start: URL, host: String) -> [URL] {
        guard let data = fetch(start), let html = String(data: data, encoding: .utf8) else { return [] }

        var found: [URL] = []
        var seen = Set<String>()
        // Deliberately a scan for href values rather than a parser: this needs
        // to find addresses, not to understand the document.
        var scanner = html[...]

        while let range = scanner.range(of: "href=", options: .caseInsensitive) {
            scanner = scanner[range.upperBound...]
            guard let quote = scanner.first, quote == "\"" || quote == "'" else { continue }
            let rest = scanner.dropFirst()
            guard let end = rest.firstIndex(of: quote) else { break }

            // href values are HTML, so entities have to be decoded before the
            // string is a usable address — otherwise every query parameter
            // arrives joined by a literal "&amp;".
            let raw = decodeEntities(String(rest[..<end]))
            scanner = rest[end...]

            guard
                let url = URL(string: raw, relativeTo: start)?.absoluteURL,
                sameSite(url, as: host),
                looksLikePage(url),
                seen.insert(normalise(url)).inserted
            else { continue }
            found.append(url)
            if found.count >= maxUrls { break }
        }

        return found
    }

    // MARK: Helpers

    /// Assets, feeds and script endpoints are not pages anybody wants in a
    /// knowledge graph. Only the crawl fallback needs this — a sitemap lists
    /// pages by definition.
    private static let nonPageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp",
        "css", "js", "mjs", "map", "json", "xml", "rss", "atom",
        "woff", "woff2", "ttf", "otf", "eot",
        "zip", "gz", "tar", "bz2", "7z", "rar",
        "pdf", "mp3", "mp4", "webm", "mov", "avi", "wav", "ogg",
    ]

    private static func looksLikePage(_ url: URL) -> Bool {
        if nonPageExtensions.contains(url.pathExtension.lowercased()) { return false }
        // `load.php?modules=…`, `api.php?action=…` and their kin serve machines.
        let path = url.path.lowercased()
        for endpoint in ["/api.php", "/load.php", "/opensearch", "/wp-json", "/xmlrpc.php", "/cgi-bin/"] {
            if path.hasSuffix(endpoint) || path.contains(endpoint) { return false }
        }
        return true
    }

    /// The handful of entities that actually occur inside an href.
    private static func decodeEntities(_ value: String) -> String {
        var result = value
        for (entity, character) in [
            ("&amp;", "&"), ("&#38;", "&"), ("&#x26;", "&"),
            ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"),
            ("&lt;", "<"), ("&gt;", ">"),
        ] {
            result = result.replacingOccurrences(of: entity, with: character, options: .caseInsensitive)
        }
        return result
    }

    private static func fetch(_ url: URL) -> Data? {
        var request = URLRequest(url: url)
        request.timeoutInterval = requestTimeout
        // Identifying the client honestly is the least an automated fetcher owes
        // the sites it reads.
        request.setValue(
            "DatabaseStudio/\(AppConfig.version) (+https://127.0.0.1; Sitemap-Leser)",
            forHTTPHeaderField: "User-Agent"
        )

        var result: Data?
        let done = DispatchSemaphore(value: 0)

        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                result = data
            }
            done.signal()
        }.resume()

        _ = done.wait(timeout: .now() + requestTimeout + 2)
        return result
    }

    /// Gzipped sitemaps are common; Foundation has no inflate, so gunzip does it.
    private static func decompressIfNeeded(_ data: Data, url: URL) -> Data {
        let looksGzipped = data.count > 2 && data[data.startIndex] == 0x1f && data[data.startIndex + 1] == 0x8b
        guard looksGzipped || url.pathExtension.lowercased() == "gz" else { return data }
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/gunzip") else { return data }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/gunzip")
        process.arguments = ["-c"]

        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            return data
        }

        var inflated = Data()
        let collecting = DispatchGroup()
        collecting.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            inflated = output.fileHandleForReading.readDataToEndOfFile()
            collecting.leave()
        }

        input.fileHandleForWriting.write(data)
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
        collecting.wait()

        return inflated.isEmpty ? data : inflated
    }

    /// Same registrable site, ignoring a leading `www.`, so a sitemap listing
    /// `www.example.com` still matches a start URL of `example.com`.
    private static func sameSite(_ url: URL, as host: String) -> Bool {
        guard let candidate = url.host, url.scheme == "http" || url.scheme == "https" else { return false }
        let a = candidate.lowercased().replacingOccurrences(of: "www.", with: "", options: .anchored)
        let b = host.lowercased().replacingOccurrences(of: "www.", with: "", options: .anchored)
        return a == b
    }

    /// Key used for de-duplication: fragments and a trailing slash never
    /// distinguish two pages.
    private static func normalise(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        var text = components?.url?.absoluteString ?? url.absoluteString
        if text.hasSuffix("/") { text.removeLast() }
        return text.lowercased()
    }
}

/// Reads `<loc>` and `<lastmod>` out of a sitemap or sitemap index.
final class SitemapParser: NSObject, XMLParserDelegate {
    struct Location {
        let loc: String
        let lastModified: String?
    }

    struct Result {
        let locations: [Location]
        /// Entries of a `<sitemapindex>`, which point at further sitemaps.
        let nested: [String]
    }

    private var locations: [Location] = []
    private var nested: [String] = []
    private var insideSitemapIndex = false
    private var currentElement = ""
    private var currentLoc = ""
    private var currentLastMod = ""

    static func parse(_ data: Data) -> Result {
        let delegate = SitemapParser()
        let parser = XMLParser(data: data)
        parser.delegate = delegate
        parser.parse()
        return Result(locations: delegate.locations, nested: delegate.nested)
    }

    func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?,
                qualifiedName: String?, attributes: [String: String]) {
        currentElement = element
        if element == "sitemapindex" { insideSitemapIndex = true }
        if element == "url" || element == "sitemap" {
            currentLoc = ""
            currentLastMod = ""
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        switch currentElement {
        case "loc": currentLoc += string
        case "lastmod": currentLastMod += string
        default: break
        }
    }

    func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?,
                qualifiedName: String?) {
        let loc = currentLoc.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !loc.isEmpty else {
            currentElement = ""
            return
        }

        if element == "sitemap" || (insideSitemapIndex && element == "loc") {
            if !nested.contains(loc) { nested.append(loc) }
        } else if element == "url" {
            let lastMod = currentLastMod.trimmingCharacters(in: .whitespacesAndNewlines)
            locations.append(Location(loc: loc, lastModified: lastMod.isEmpty ? nil : lastMod))
        }

        if element == "url" || element == "sitemap" {
            currentLoc = ""
            currentLastMod = ""
        }
        currentElement = ""
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler,
                         WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var titleBarDragView: TitleBarDragView!
    private let server = IngestServer()
    private let projects = ProjectRegistry()
    private let redisConnections = RedisConnectionStore()
    private let savedConnections = ConnectionRegistry()
    private let snapshotSessions = SnapshotSessionManager()
    private let apiServer = ApiServer(config: ApiServer.Config(
        appName: AppConfig.bundleName,
        storageDirectoryName: AppConfig.storageDirectoryName,
        version: AppConfig.version,
        tokenFileName: AppConfig.apiDescriptorFileName
    ))
    /// API requests waiting on the renderer, keyed by the id the page echoes back.
    private var pendingApiReplies: [Int: (ApiServer.Reply) -> Void] = [:]
    private var nextApiCallID = 1
    private var isReady = false
    /// A reopen/activation event can arrive while the background-launched app
    /// is still starting its listeners, before `setupWindow()` has assigned
    /// `window`. Keep that user intent until a real window can consume it.
    private var pendingWindowPresentation = false
    private var windowPresentationScheduled = false
    /// Files and payloads that arrived before the UI could receive them.
    private var pendingFiles: [URL] = []
    private var pendingPayloads: [Data] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: AppConfig.supportDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: AppConfig.cacheDirectory, withIntermediateDirectories: true)
        do {
            let migration = try LocalRedisService.migrateLegacyDataIfSafe()
            if migration["migrated"] as? Bool == true {
                NSLog("Lokaler Redis-Speicher von Vektor wurde migriert.")
            }
        } catch {
            // A conflict is intentionally non-destructive. The snapshot/project
            // workspaces remain usable and the next launch can retry.
            NSLog("Lokaler Redis-Speicher wurde nicht migriert: \(error.localizedDescription)")
        }
        do {
            try installBundledBrowserExtensionIfNeeded()
        } catch {
            NSLog("Browser-Erweiterung konnte nicht bereitgestellt werden: \(error.localizedDescription)")
        }
        migrateLegacyApiPreferencesIfNeeded()
        try? migrateLegacySettingsIfNeeded()

        server.onPayload = { [weak self] data in
            self?.deliver(payload: data)
        }

        server.projectsProvider = { [weak self] in
            self?.projects.extensionProjects() ?? []
        }

        // The browser extension must remain reachable even while the unified
        // shell is showing its home or table workspace (and when a LaunchAgent
        // starts the app with --background). The UI may call start again; the
        // server treats an identical port as a no-op.
        do {
            try server.start(port: storedIngestPort())
        } catch {
            NSLog("Import-Server konnte nicht starten: \(error.localizedDescription)")
        }

        setupWindow()
        setupMenu()
        setupApiServer()
        if !AppConfig.launchedInBackground {
            activateApplication()
        }
    }

    /// The window is the UI, not the app. Closing it leaves the ingest server
    /// listening so the extension keeps working; the app is quit from the menu.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// This app creates one durable workbench window itself. Restoring AppKit's
    /// previous "window was closed" snapshot on top of that would immediately
    /// hide a freshly launched build before the renderer can appear.
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        false
    }

    /// Reached by opening the app from Spotlight, Finder or the Dock while it
    /// is already running in the background — that is the gesture that asks for
    /// the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        presentWindow()
        return true
    }

    /// Brings the app out of background mode: dock icon, menu bar, window.
    func presentWindow() {
        pendingWindowPresentation = true
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
        activateApplication()
        // Changing an accessory process into a regular app is applied by
        // WindowServer on the next run-loop turn. Ordering the window in the
        // same stack frame can therefore leave a frontmost app with no visible
        // window. Defer the reveal until that transition has settled.
        scheduleWindowPresentation()
    }

    private func activateApplication() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// `open -a` may activate an existing process without delivering a reopen
    /// callback. If that activation has no visible window, treat it as the
    /// user's reveal gesture for both a background-started and a normal app.
    /// The initial login launch remains hidden because an accessory app never
    /// becomes active here.
    func applicationDidBecomeActive(_ notification: Notification) {
        guard NSApp.activationPolicy() == .regular,
              window != nil,
              !window.isVisible else { return }
        pendingWindowPresentation = true
        scheduleWindowPresentation()
    }

    private func scheduleWindowPresentation() {
        guard pendingWindowPresentation, !windowPresentationScheduled else { return }
        windowPresentationScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.windowPresentationScheduled = false
            self.revealMainWindowIfReady()
        }
    }

    private func revealMainWindowIfReady() {
        guard pendingWindowPresentation, window != nil else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        // `isVisible` also stays true for a window parked on another Space.
        // Keep an already ordered window attached to its current Space while
        // applying `moveToActiveSpace`. Ordering it out first can detach the
        // workbench during a second Finder-open even though it was already on
        // screen, leaving a loaded document with no visible window.
        window.collectionBehavior.remove(.canJoinAllSpaces)
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        if window.isVisible {
            pendingWindowPresentation = false
        } else {
            // WindowServer can need more than one run-loop turn after an
            // accessory-to-regular transition. Keep the intent until the
            // window really became visible instead of silently dropping it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                self?.scheduleWindowPresentation()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        redisConnections.closeAll()
        snapshotSessions.stopAll()
        server.stop()
        // The descriptor advertises a reachable port; leaving it behind would
        // point every client at a socket that is gone.
        apiServer.stop()
        // Downloaded media is scratch space; leaving it behind would grow
        // without bound across sessions.
        try? FileManager.default.removeItem(at: AppConfig.cacheDirectory)
    }

    // MARK: Window

    private func setupWindow() {
        let configuration = WKWebViewConfiguration()
        let resources = Bundle.main.resourceURL!.appendingPathComponent("dist", isDirectory: true)
        configuration.setURLSchemeHandler(AssetSchemeHandler(root: resources), forURLScheme: "app")

        for handler in ["appReady", "rpc", "api", "windowDrag"] {
            configuration.userContentController.add(self, name: handler)
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = AppConfig.bundleName
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isRestorable = false
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.backgroundColor = NSColor(red: 10 / 255, green: 12 / 255, blue: 16 / 255, alpha: 1)
        window.minSize = NSSize(width: 960, height: 620)
        window.center()
        window.setFrameAutosaveName("DatabaseStudioMainWindow")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: URL(string: "app://localhost/index.html")!))

        window.contentView?.addSubview(webView)

        // Sits above the web view so a press on the app's own title bar moves
        // the window; the page reports which parts must stay clickable.
        titleBarDragView = TitleBarDragView(
            frame: NSRect(x: 0, y: window.contentView!.bounds.height - 48,
                          width: window.contentView!.bounds.width, height: 48)
        )
        titleBarDragView.autoresizingMask = [.width, .minYMargin]
        window.contentView?.addSubview(titleBarDragView)

        window.delegate = self

        if !AppConfig.launchedInBackground {
            pendingWindowPresentation = true
            // A normal Finder/Dock launch already has regular activation
            // policy, so show synchronously while the launch gesture is still
            // authoritative. The deferred path remains for LaunchAgent
            // promotion, where WindowServer genuinely needs another turn.
            revealMainWindowIfReady()
        } else {
            // Also consumes a reopen/activation that arrived before `window`
            // was assigned during a slow background launch.
            scheduleWindowPresentation()
        }
    }

    /// Closing the window in background mode returns the app to where it was:
    /// no dock icon, no menu bar, ingest server still listening.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        pendingWindowPresentation = false
        window.orderOut(nil)
        if AppConfig.launchedInBackground {
            NSApp.setActivationPolicy(.accessory)
        }
        return false
    }

    /// Keeps the web title bar aligned with the native traffic lights. macOS
    /// removes those controls in full screen, so the renderer can reclaim the
    /// reserved leading space without guessing from viewport dimensions.
    private func syncWindowFullscreenState() {
        guard window != nil, webView != nil else { return }
        let value = window.styleMask.contains(.fullScreen) ? "true" : "false"
        evaluate("document.documentElement.dataset.windowFullscreen = '\(value)';")
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        syncWindowFullscreenState()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        syncWindowFullscreenState()
    }

    private func setupMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Über \(AppConfig.bundleName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "\(AppConfig.bundleName) ausblenden", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "\(AppConfig.bundleName) beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "Ablage")
        fileMenu.addItem(withTitle: "Öffnen…", action: #selector(openDocument), keyEquivalent: "o")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Cache-Ordner zeigen", action: #selector(revealCache), keyEquivalent: "")
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Bearbeiten")
        editMenu.addItem(withTitle: "Widerrufen", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Wiederholen", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Ausschneiden", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Einsetzen", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        NSApp.mainMenu = mainMenu
    }

    // MARK: Menu actions
    //
    // The native picker only stages a file. Format detection and the choice of
    // workspace stay in the shared renderer, exactly like Finder-open.

    @objc private func openDocument() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = AppConfig.openContentTypes
        panel.message = "Datenbank- oder Datendatei auswählen"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        deliver(fileAt: url)
    }

    @objc private func revealCache() {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: AppConfig.cacheDirectory.path)
    }

    // MARK: Finder integration

    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        // A double-clicked graph is meant to be looked at, so this always
        // brings the window up even if the app was running in the background.
        presentWindow()
        deliver(fileAt: URL(fileURLWithPath: filename))
        return true
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        presentWindow()
        for filename in filenames { deliver(fileAt: URL(fileURLWithPath: filename)) }
        NSApp.reply(toOpenOrPrint: .success)
    }

    private func deliver(fileAt url: URL) {
        guard isReady else {
            pendingFiles.append(url)
            return
        }
        let token = StagedFileStore.shared.stage(url)
        let pendingWal = ProjectScanner.projectFileType(url) == "sqlite"
            && ProjectScanner.hasPendingWal(for: url)
        // The path travels along so the renderer can write the graph back to
        // where it came from; a file without a known home cannot autosave.
        evaluate("""
        (window.databaseStudio || window.graphStudio)?.openFile?.('app://localhost/staged/\(token)', \(jsString(url.lastPathComponent)), \(jsString(url.path)), \(pendingWal ? "true" : "false"));
        """)
    }

    private func deliver(payload: Data) {
        guard isReady else {
            pendingPayloads.append(payload)
            return
        }
        evaluate("(window.databaseStudio || window.graphStudio)?.onIngest?.('\(payload.base64EncodedString())');")
    }

    // MARK: - RPC

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "windowDrag" {
            if let body = message.body as? [String: Any] { applyDragRegions(body) }
            return
        }

        if message.name == "api" {
            // Kept off the generic dispatch on purpose: these calls touch
            // `pendingApiReplies` and the server, which are main-thread state.
            if let body = message.body as? [String: Any] { handleApiControl(body) }
            return
        }

        if message.name == "appReady" {
            isReady = true
            for url in pendingFiles { deliver(fileAt: url) }
            for payload in pendingPayloads { deliver(payload: payload) }
            pendingFiles.removeAll()
            pendingPayloads.removeAll()
            return
        }

        guard
            let body = message.body as? [String: Any],
            let requestId = body["id"] as? Int,
            let channel = body["channel"] as? String,
            let method = body["method"] as? String
        else { return }

        let params = body["params"] as? [String: Any] ?? [:]

        // Anything that touches the disk, spawns a process or waits on the
        // network runs off the main thread; the UI must not freeze while a
        // ten-minute video is being transcoded.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.perform(channel: channel, method: method, params: params)
                DispatchQueue.main.async { self.respond(to: requestId, with: result) }
            } catch {
                DispatchQueue.main.async {
                    self.respond(to: requestId, error: error.localizedDescription)
                }
            }
        }
    }

    // MARK: Local HTTP API

    /**
     Wires the API server to the web view.

     Nothing is answered here. A request arrives on the socket, is handed to the
     renderer as base64 JSON, and the renderer's `reply` unblocks it — the graph
     only exists in there, so this is the only place it can be answered from.
     */
    private func setupApiServer() {
        apiServer.onCall = { [weak self] call, finish in
            guard let self else {
                finish(ApiServer.Reply(status: 503, json: Data(#"{"error":"App beendet"}"#.utf8)))
                return
            }
            self.forwardToRenderer(call, finish)
        }

        guard UserDefaults.standard.bool(forKey: AppConfig.apiEnabledKey) else { return }
        do {
            try apiServer.start(port: storedApiPort())
        } catch {
            // Not fatal: everything else works without the API, and the tab
            // explains why the port did not come up.
            NSLog("API-Server konnte nicht starten: \(error.localizedDescription)")
        }
    }

    private func storedApiPort() -> UInt16 {
        let stored = UserDefaults.standard.integer(forKey: AppConfig.apiPortKey)
        guard stored > 0, stored <= 65_535 else { return AppConfig.defaultApiPort }
        return UInt16(stored)
    }

    private func storedIngestPort() -> UInt16 {
        guard let data = try? Data(contentsOf: settingsURL),
              let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = settings["ingestPort"] as? Int,
              value >= 1024, value <= 65_535 else {
            return AppConfig.defaultIngestPort
        }
        return UInt16(value)
    }

    /// Copies the extension out of the sealed app bundle into a stable folder
    /// Chrome can remember. A version match avoids replacing a live unpacked
    /// extension on every launch.
    private func installBundledBrowserExtensionIfNeeded() throws {
        guard let resources = Bundle.main.resourceURL else { return }
        let source = resources.appendingPathComponent("extension", isDirectory: true)
        let sourceManifest = source.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: sourceManifest.path) else { return }

        let destination = AppConfig.browserExtensionDirectory
        let destinationManifest = destination.appendingPathComponent("manifest.json")
        if manifestVersion(at: sourceManifest) == manifestVersion(at: destinationManifest),
           FileManager.default.fileExists(atPath: destinationManifest.path) {
            return
        }

        let staging = AppConfig.supportDirectory
            .appendingPathComponent(".browser-extension-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        try FileManager.default.copyItem(at: source, to: staging)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: staging, to: destination)
    }

    private func manifestVersion(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object["version"] as? String
    }

    private func forwardToRenderer(_ call: ApiServer.Call, _ finish: @escaping (ApiServer.Reply) -> Void) {
        guard isReady else {
            finish(ApiServer.Reply(
                status: 503,
                json: Data(#"{"error":"Die Oberfläche ist noch nicht bereit."}"#.utf8)
            ))
            return
        }

        let id = nextApiCallID
        nextApiCallID += 1
        pendingApiReplies[id] = finish

        let payload: [String: Any] = [
            "method": call.method,
            "path": call.path,
            "query": call.query,
            // The body travels as text: it is JSON the renderer parses itself,
            // and re-encoding it here would only be a second chance to mangle it.
            "body": String(data: call.body, encoding: .utf8) ?? "",
        ]
        let json = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
        evaluate("""
            (window.databaseStudio || window.graphStudio)?.__apiRequest?.(\(id), "\(json.base64EncodedString())");
            """)
    }

    /// The `api` message channel: the renderer's replies plus the switches the
    /// API tab offers. Answers travel back through the normal `__resolve` path.
    private func handleApiControl(_ message: [String: Any]) {
        let id = message["id"] as? Int ?? 0
        let method = message["method"] as? String ?? ""
        let params = message["params"] as? [String: Any] ?? [:]

        switch method {
        case "reply":
            guard
                let callID = params["callId"] as? Int,
                let status = params["status"] as? Int,
                let json = params["json"] as? String
            else {
                respond(to: id, error: "Unvollständige Antwort.")
                return
            }
            pendingApiReplies.removeValue(forKey: callID)?(
                ApiServer.Reply(status: status, json: Data(json.utf8))
            )
            respond(to: id, with: ["accepted": true])

        case "health":
            let adapter = params["adapter"] as? String ?? "graph"
            guard ["sqlite", "graph", "vault"].contains(adapter) else {
                respond(to: id, error: "Unbekannter Health-Adapter \"\(adapter)\".")
                return
            }
            apiServer.updateHealth(params["health"] as? [String: Any] ?? [:], adapter: adapter)
            respond(to: id, with: ["accepted": true])

        case "status":
            respond(to: id, with: apiStatusPayload())

        case "start":
            let port = (params["port"] as? Int).flatMap { $0 > 0 && $0 <= 65_535 ? UInt16($0) : nil }
                ?? storedApiPort()
            do {
                try apiServer.start(port: port)
                UserDefaults.standard.set(true, forKey: AppConfig.apiEnabledKey)
                UserDefaults.standard.set(Int(port), forKey: AppConfig.apiPortKey)
                respond(to: id, with: apiStatusPayload())
            } catch {
                respond(to: id, error: error.localizedDescription)
            }

        case "stop":
            apiServer.stop()
            UserDefaults.standard.set(false, forKey: AppConfig.apiEnabledKey)
            respond(to: id, with: apiStatusPayload())

        case "rotateToken":
            apiServer.rotateToken()
            respond(to: id, with: apiStatusPayload())

        case "setAllowWrites":
            let key: String
            switch params["adapter"] as? String ?? "graph" {
            case "sqlite": key = AppConfig.apiAllowWritesSQLiteKey
            case "vault", "redis": key = AppConfig.apiAllowWritesVaultKey
            default: key = AppConfig.apiAllowWritesKey
            }
            UserDefaults.standard.set(params["allowWrites"] as? Bool ?? false,
                                      forKey: key)
            respond(to: id, with: apiStatusPayload())

        default:
            respond(to: id, error: "Unbekannte API-Aktion \"\(method)\".")
        }
    }

    private func apiStatusPayload() -> [String: Any] {
        [
            "running": apiServer.isRunning,
            "port": Int(apiServer.isRunning ? apiServer.port : storedApiPort()),
            "token": apiServer.isRunning ? apiServer.currentToken : "",
            "descriptorPath": apiServer.descriptorURL.path,
            "allowWrites": UserDefaults.standard.bool(forKey: AppConfig.apiAllowWritesKey),
            "allowWritesByAdapter": [
                "sqlite": UserDefaults.standard.bool(forKey: AppConfig.apiAllowWritesSQLiteKey),
                "graph": UserDefaults.standard.bool(forKey: AppConfig.apiAllowWritesKey),
                "vault": UserDefaults.standard.bool(forKey: AppConfig.apiAllowWritesVaultKey),
            ],
        ]
    }

    /// A new bundle gets an empty preferences domain. Import the three old API
    /// switches once, but deliberately keep the canonical port at 8793 so the
    /// legacy apps can continue using 8790-8792 alongside Database Studio.
    private func migrateLegacyApiPreferencesIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: AppConfig.apiMigrationKey) else { return }
        let sources: [(domain: String, enabled: String, writes: String, target: String)] = [
            ("com.oskarschiermeister.sqlitestudio", "com.sqlitestudio.api.enabled",
             "com.sqlitestudio.api.allowWrites", AppConfig.apiAllowWritesSQLiteKey),
            ("com.oskarschiermeister.graphstudio", "com.graphstudio.api.enabled",
             "com.graphstudio.api.allowWrites", AppConfig.apiAllowWritesKey),
            ("com.oskarschiermeister.vaultstudio", "com.vaultstudio.api.enabled",
             "com.vaultstudio.api.allowWrites", AppConfig.apiAllowWritesVaultKey),
        ]

        var enabled = false
        for source in sources {
            let values = UserDefaults.standard.persistentDomain(forName: source.domain) ?? [:]
            enabled = enabled || (values[source.enabled] as? Bool ?? false)
            if let allowWrites = values[source.writes] as? Bool {
                UserDefaults.standard.set(allowWrites, forKey: source.target)
            }
        }
        UserDefaults.standard.set(enabled, forKey: AppConfig.apiEnabledKey)
        UserDefaults.standard.set(Int(AppConfig.defaultApiPort), forKey: AppConfig.apiPortKey)
        UserDefaults.standard.set(true, forKey: AppConfig.apiMigrationKey)
    }

    private func perform(channel: String, method: String, params: [String: Any]) throws -> Any? {
        switch channel {
        case "sources":
            guard method == "read" else { throw NativeError("Unbekannte Quellenmethode.") }
            return try DataSources.read(params)
        case "files": return try performFiles(method, params)
        case "settings": return try performSettings(method, params)
        case "server": return try performServer(method, params)
        case "media": return try performMedia(method, params)
        case "map": return try performMap(method, params)
        case "projects": return try performProjects(method, params)
        case "redis": return try performRedis(method, params)
        default: throw NativeError("Unbekannter Kanal: \(channel)")
        }
    }

    // MARK: Files

    private func performFiles(_ method: String, _ params: [String: Any]) throws -> Any? {
        switch method {
        case "pick":
            guard let url = runOpenPanel() else { return nil }
            return stagedFilePayload(for: url)

        case "open":
            guard let url = runOpenPanel() else { return nil }
            return try readFile(at: url)

        case "read":
            guard let path = params["path"] as? String else { throw NativeError("path fehlt") }
            return try readFile(at: URL(fileURLWithPath: path))

        case "stage":
            guard let path = params["path"] as? String else { throw NativeError("path fehlt") }
            let url = URL(fileURLWithPath: path).standardizedFileURL
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue,
                  FileManager.default.isReadableFile(atPath: url.path) else {
                throw NativeError("Datei nicht lesbar: \(url.path)")
            }
            return stagedFilePayload(for: url)

        case "write":
            guard
                let path = params["path"] as? String,
                let contents = params["contents"] as? String
            else { throw NativeError("path oder contents fehlt") }
            try contents.write(to: URL(fileURLWithPath: path), atomically: true, encoding: .utf8)
            return ["path": path]

        case "saveAs":
            let suggested = params["suggestedName"] as? String ?? "graph.graph"
            let contents = params["contents"] as? String ?? ""
            guard let url = runSavePanel(suggestedName: suggested) else { return nil }
            try contents.write(to: url, atomically: true, encoding: .utf8)
            return ["path": url.path]

        case "reveal":
            guard let path = params["path"] as? String else { throw NativeError("path fehlt") }
            NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: (path as NSString).deletingLastPathComponent)
            return nil

        case "chooseFolder":
            let message = params["message"] as? String ?? "Ordner auswählen"
            guard let url = runFolderPanel(message: message) else { return nil }
            return ["path": url.path, "name": url.lastPathComponent]

        case "readFolder":
            guard let path = params["path"] as? String else { throw NativeError("path fehlt") }
            let ext = params["extension"] as? String ?? ""
            return try readFolder(at: URL(fileURLWithPath: path), extension: ext)

        default:
            throw NativeError("Unbekannte Methode: files.\(method)")
        }
    }

    private func stagedFilePayload(for url: URL) -> [String: Any] {
        let token = StagedFileStore.shared.stage(url)
        var payload: [String: Any] = [
            "url": "app://localhost/staged/\(token)",
            "path": url.path,
            "name": url.lastPathComponent,
        ]
        if ProjectScanner.projectFileType(url) == "sqlite" {
            payload["pendingWal"] = ProjectScanner.hasPendingWal(for: url)
        }
        return payload
    }

    private func readFile(at url: URL) throws -> [String: Any] {
        let contents = try String(contentsOf: url, encoding: .utf8)
        return ["path": url.path, "name": url.lastPathComponent, "contents": contents]
    }

    private func runOpenPanel() -> URL? {
        var result: URL?
        DispatchQueue.main.sync {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.allowedContentTypes = AppConfig.openContentTypes
            panel.message = "Datenbank- oder Datendatei auswählen"
            result = panel.runModal() == .OK ? panel.url : nil
        }
        return result
    }

    /// One flat directory of small text files. Deliberately not recursive and
    /// deliberately capped: this reads whatever folder the user pointed at, and
    /// an accidental pick of a home directory must fail fast rather than walk a
    /// disk. Records are a few kilobytes each; anything far larger is not one.
    private func readFolder(at url: URL, extension ext: String) throws -> [String: Any] {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw NativeError("Kein Ordner: \(url.path)")
        }

        let names = try FileManager.default.contentsOfDirectory(atPath: url.path).sorted()
        var files: [[String: Any]] = []
        var skipped = 0

        for name in names {
            if name.hasPrefix(".") { continue }
            if !ext.isEmpty && !name.lowercased().hasSuffix(ext.lowercased()) { continue }
            if files.count >= AppConfig.maxFolderFiles {
                skipped += 1
                continue
            }

            let file = url.appendingPathComponent(name)
            var fileIsDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: file.path, isDirectory: &fileIsDirectory),
                  !fileIsDirectory.boolValue else { continue }

            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= AppConfig.maxFolderFileBytes, let contents = try? String(contentsOf: file, encoding: .utf8) else {
                skipped += 1
                continue
            }
            files.append(["name": name, "path": file.path, "contents": contents])
        }

        return ["path": url.path, "files": files, "skipped": skipped]
    }

    private func runFolderPanel(message: String) -> URL? {
        var result: URL?
        DispatchQueue.main.sync {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.message = message
            result = panel.runModal() == .OK ? panel.url : nil
        }
        return result
    }

    private func runSavePanel(suggestedName: String) -> URL? {
        var result: URL?
        DispatchQueue.main.sync {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedName
            panel.allowedContentTypes = AppConfig.graphContentTypes
            panel.message = "Graph sichern"
            result = panel.runModal() == .OK ? panel.url : nil
        }
        return result
    }

    // MARK: Settings

    private var settingsURL: URL {
        AppConfig.supportDirectory.appendingPathComponent(AppConfig.settingsFileName)
    }

    private func performSettings(_ method: String, _ params: [String: Any]) throws -> Any? {
        switch method {
        case "load":
            try migrateLegacySettingsIfNeeded()
            guard let data = try? Data(contentsOf: settingsURL) else { return nil }
            let object = try JSONSerialization.jsonObject(with: data)
            // The server answers /status and /targets from this, so it has to
            // know the stored values before the renderer pushes anything.
            if let settings = object as? [String: Any] { applySnapshot(from: settings) }
            return object

        case "save":
            guard let settings = params["settings"] as? [String: Any] else {
                throw NativeError("settings fehlt")
            }
            let data = try JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: settingsURL, options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: settingsURL.path
            )
            applySnapshot(from: settings)
            return nil

        default:
            throw NativeError("Unbekannte Methode: settings.\(method)")
        }
    }

    /// Graph provider keys used to live in Graph Studio's settings file. Copy
    /// the validated JSON once and tighten its permissions in the new support
    /// directory; the legacy app keeps its own file and remains usable.
    private func migrateLegacySettingsIfNeeded() throws {
        guard !FileManager.default.fileExists(atPath: settingsURL.path),
              FileManager.default.fileExists(atPath: AppConfig.legacyGraphSettingsURL.path) else { return }
        let data = try Data(contentsOf: AppConfig.legacyGraphSettingsURL)
        _ = try JSONSerialization.jsonObject(with: data)
        try data.write(to: settingsURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: settingsURL.path
        )
    }

    private func applySnapshot(from settings: [String: Any]) {
        server.updateSnapshot { snapshot in
            if let usage = settings["usage"] as? [String: Any] {
                let input = usage["inputTokens"] as? Int ?? 0
                let output = usage["outputTokens"] as? Int ?? 0
                snapshot.tokensUsed = input + output
            }
            snapshot.defaultTargetId = settings["defaultTargetId"] as? String ?? ""
            // Passwords and endpoints stay in the app; the extension only needs
            // enough to render a picker.
            snapshot.targets = (settings["targets"] as? [[String: Any]] ?? []).map { target in
                [
                    "id": target["id"] as? String ?? "",
                    "name": target["name"] as? String ?? "",
                    "kind": target["kind"] as? String ?? "",
                ]
            }
        }
    }

    // MARK: Site map

    private func performMap(_ method: String, _ params: [String: Any]) throws -> Any? {
        guard
            let raw = params["url"] as? String,
            let url = URL(string: raw),
            url.host != nil
        else { throw NativeError("Ungültige Adresse") }

        switch method {
        case "discover":
            let limit = params["limit"] as? Int ?? 500
            return SiteMapper.discover(start: url, limit: max(1, min(limit, SiteMapper.maxUrls)))

        case "fetchPage":
            // The renderer cannot fetch an arbitrary site — cross-origin reads
            // are blocked there — so the host does it and hands back the HTML.
            guard let page = SiteMapper.fetchPage(url) else {
                throw NativeError("Seite konnte nicht geladen werden: \(url.absoluteString)")
            }
            return page

        default:
            throw NativeError("Unbekannte Methode: map.\(method)")
        }
    }

    // MARK: Projects

    private func performProjects(_ method: String, _ params: [String: Any]) throws -> Any? {
        switch method {
        case "list":
            return projects.listedProjects()

        case "add":
            guard let url = runFolderPanel() else { return nil }
            projects.add(url.path)
            return projects.scan(url.path)

        case "remove":
            guard let id = params["id"] as? String else { throw NativeError("id fehlt") }
            projects.remove(id)
            return nil

        case "refresh":
            guard let id = params["id"] as? String else { throw NativeError("id fehlt") }
            guard projects.paths.contains(id) else { return nil }
            return projects.scan(id)

        case "openRedisSnapshot", "openSnapshot", "open":
            return try performRedis("openSnapshot", params)

        case "closeRedisSnapshot", "closeSnapshot", "close":
            return try performRedis("closeSnapshot", params)

        default:
            throw NativeError("Unbekannte Methode: projects.\(method)")
        }
    }

    private func runFolderPanel() -> URL? {
        var result: URL?
        DispatchQueue.main.sync {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.message = "Ordner mit Datenbanken oder Datendateien auswählen"
            panel.prompt = "Hinzufügen"
            result = panel.runModal() == .OK ? panel.url : nil
        }
        return result
    }

    // MARK: Redis

    /// Redis uses the same generic RPC envelope as every other native service.
    /// Calls already arrive on a background queue, so socket commands and
    /// snapshot startup cannot block the web view or the window server.
    private func performRedis(_ method: String, _ params: [String: Any]) throws -> Any? {
        switch method {
        case "localStoreMigrationStatus":
            return LocalRedisService.migrationStatus()

        case "migrateLocalStore":
            return try LocalRedisService.migrateLegacyDataIfSafe()

        case "ensureLocal":
            return try LocalRedisService.ensureRunning()

        case "connect":
            let config = RedisConfig(json: params)
            let connection = RedisConnection(config: config)
            try connection.open()
            let handle = redisConnections.add(connection)
            return [
                "connectionId": handle,
                "host": config.host,
                "port": Int(config.port),
                "db": config.database,
            ]

        case "command":
            guard let handle = params["connectionId"] as? String,
                  let arguments = params["args"] as? [String], !arguments.isEmpty else {
                throw NativeError("Befehl unvollständig.")
            }
            guard let connection = redisConnections.get(handle) else {
                throw NativeError("Unbekannte Verbindung.")
            }
            return ["value": try connection.send(arguments).json]

        case "pipeline":
            guard let handle = params["connectionId"] as? String,
                  let batch = params["commands"] as? [[String]] else {
                throw NativeError("Stapel unvollständig.")
            }
            guard let connection = redisConnections.get(handle) else {
                throw NativeError("Unbekannte Verbindung.")
            }
            var replies: [Any] = []
            replies.reserveCapacity(batch.count)
            for arguments in batch where !arguments.isEmpty {
                replies.append(try connection.send(arguments).json)
            }
            return ["values": replies]

        case "close":
            if let handle = params["connectionId"] as? String,
               let config = redisConnections.remove(handle) {
                snapshotSessions.stop(port: Int(config.port))
            }
            return ["closed": true]

        case "savedList":
            return savedConnections.entries.map(\.json)

        case "savedUpsert":
            guard let host = params["host"] as? String, !host.isEmpty else {
                throw NativeError("Kein Host angegeben.")
            }
            let entry = SavedConnection(
                id: params["savedId"] as? String ?? UUID().uuidString,
                name: (params["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? host,
                host: host,
                port: params["port"] as? Int ?? 6379,
                database: params["db"] as? Int ?? 0,
                username: params["username"] as? String ?? ""
            )
            // A missing password means the existing keychain item is left
            // untouched. An explicit empty string intentionally clears it.
            savedConnections.upsert(entry, password: params["password"] as? String)
            return savedConnections.entries.map(\.json)

        case "savedRemove":
            if let savedID = params["savedId"] as? String {
                savedConnections.remove(id: savedID)
            }
            return savedConnections.entries.map(\.json)

        case "savedPassword":
            guard let savedID = params["savedId"] as? String else {
                throw NativeError("Keine Verbindung angegeben.")
            }
            return ["password": Keychain.password(for: savedID)]

        case "snapshots", "listSnapshots":
            return projects.paths.map {
                VaultProjectScanner.project(at: URL(fileURLWithPath: $0))
            }

        case "openSnapshot", "projectOpen":
            guard let artifact = redisArtifact(from: params) else {
                throw NativeError("Der Redis-Speicherstand wurde im Projektordner nicht mehr gefunden.")
            }
            return try snapshotSessions.open(artifact)

        case "closeSnapshot", "projectClose":
            if let sessionID = params["sessionId"] as? String {
                snapshotSessions.stop(id: sessionID)
            }
            return ["closed": true]

        default:
            throw NativeError("Unbekannte Methode: redis.\(method)")
        }
    }

    private func redisArtifact(from params: [String: Any]) -> RedisArtifact? {
        let artifactID = params["databaseId"] as? String
            ?? params["artifactId"] as? String
            ?? params["id"] as? String
        if let artifactID,
           let artifact = VaultProjectScanner.artifact(withID: artifactID, in: projects.paths) {
            return artifact
        }

        guard let rawPath = params["path"] as? String else { return nil }
        let requested = URL(fileURLWithPath: rawPath).standardizedFileURL.path
        for root in projects.paths {
            let result = VaultProjectScanner.artifacts(in: URL(fileURLWithPath: root))
            if let artifact = result.artifacts.first(where: {
                $0.anchorURL.standardizedFileURL.path == requested
                    || $0.components.contains(where: { $0.standardizedFileURL.path == requested })
            }) {
                return artifact
            }
        }
        return VaultProjectScanner.standaloneArtifact(at: URL(fileURLWithPath: requested))
    }

    // MARK: Server

    private func performServer(_ method: String, _ params: [String: Any]) throws -> Any? {
        switch method {
        case "status":
            return server.statusPayload()

        case "start":
            let port = UInt16(params["port"] as? Int ?? Int(AppConfig.defaultIngestPort))
            try server.start(port: port)
            return server.statusPayload()

        case "stop":
            server.stop()
            return server.statusPayload()

        case "extensionInfo":
            let manifest = AppConfig.browserExtensionDirectory.appendingPathComponent("manifest.json")
            return [
                "available": FileManager.default.fileExists(atPath: manifest.path),
                "path": AppConfig.browserExtensionDirectory.path,
                "version": manifestVersion(at: manifest) ?? "",
            ]

        case "setState":
            server.updateSnapshot { snapshot in
                if let name = params["graphName"] as? String { snapshot.graphName = name }
                if let path = params["graphPath"] as? String { snapshot.graphPath = path }
                if let count = params["nodeCount"] as? Int { snapshot.nodeCount = count }
                if let tokens = params["tokensUsed"] as? Int { snapshot.tokensUsed = tokens }
            }
            return nil

        default:
            throw NativeError("Unbekannte Methode: server.\(method)")
        }
    }

    // MARK: Media

    private func performMedia(_ method: String, _ params: [String: Any]) throws -> Any? {
        switch method {
        case "tools":
            return [
                "ytdlp": Tools.locate("yt-dlp") as Any,
                "ffmpeg": Tools.locate("ffmpeg") as Any,
                "ffprobe": Tools.locate("ffprobe") as Any,
            ]

        case "probe":
            guard let url = params["url"] as? String else { throw NativeError("url fehlt") }
            return try probe(url)

        case "download":
            guard
                let url = params["url"] as? String,
                let jobId = params["jobId"] as? String
            else { throw NativeError("url oder jobId fehlt") }
            return try download(url, jobId: jobId)

        case "extractAudio":
            guard let path = params["path"] as? String else { throw NativeError("path fehlt") }
            return try extractAudio(from: path)

        case "extractFrames":
            guard let path = params["path"] as? String else { throw NativeError("path fehlt") }
            let interval = params["intervalSeconds"] as? Int ?? 15
            let maxFrames = params["maxFrames"] as? Int ?? 40
            return try extractFrames(from: path, interval: interval, maxFrames: maxFrames)

        case "cleanup":
            guard let path = params["path"] as? String else { return nil }
            let url = URL(fileURLWithPath: path)
            // Only ever delete inside the app's own cache directory.
            guard url.path.hasPrefix(AppConfig.cacheDirectory.path) else { return nil }
            try? FileManager.default.removeItem(at: url)
            return nil

        default:
            throw NativeError("Unbekannte Methode: media.\(method)")
        }
    }

    private func probe(_ url: String) throws -> [String: Any] {
        guard let ytdlp = Tools.locate("yt-dlp") else {
            throw NativeError("yt-dlp nicht gefunden. Installieren mit: brew install yt-dlp")
        }

        let result = try Tools.run(ytdlp, ["--dump-single-json", "--no-warnings", "--skip-download", url], timeout: 60)
        guard result.status == 0,
              let data = result.standardOutput.data(using: .utf8),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeError("Metadaten konnten nicht gelesen werden: \(result.standardError.prefix(300))")
        }

        return [
            "title": info["title"] as? String ?? "",
            "durationSeconds": Int(info["duration"] as? Double ?? 0),
            "uploader": info["uploader"] as? String ?? "",
            "uploadDate": info["upload_date"] as? String ?? "",
            "description": info["description"] as? String ?? "",
            "thumbnail": info["thumbnail"] as? String ?? "",
            "viewCount": info["view_count"] as? Int ?? 0,
            "webpageUrl": info["webpage_url"] as? String ?? url,
        ]
    }

    private func download(_ url: String, jobId: String) throws -> [String: Any] {
        guard let ytdlp = Tools.locate("yt-dlp") else {
            throw NativeError("yt-dlp nicht gefunden. Installieren mit: brew install yt-dlp")
        }

        let directory = AppConfig.cacheDirectory.appendingPathComponent(jobId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        var arguments = [
            // 720p is the sweet spot: enough detail for the vision pass to read
            // on-screen text, a fraction of the bytes of the source stream.
            "-f", "bv*[height<=720]+ba/b[height<=720]/b",
            "--no-playlist",
            "--no-warnings",
            "--print-json",
            "--no-progress",
            "-o", directory.appendingPathComponent("media.%(ext)s").path,
        ]
        if let ffmpeg = Tools.locate("ffmpeg") {
            arguments.append(contentsOf: ["--ffmpeg-location", (ffmpeg as NSString).deletingLastPathComponent])
        }
        arguments.append(url)

        let result = try Tools.run(ytdlp, arguments, timeout: 1800)
        guard result.status == 0 else {
            throw NativeError("Download fehlgeschlagen: \(result.standardError.suffix(300))")
        }

        let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        guard let file = contents.first(where: { $0.lastPathComponent.hasPrefix("media.") }) else {
            throw NativeError("Die heruntergeladene Datei wurde nicht gefunden.")
        }

        var title = ""
        var duration = 0
        if let line = result.standardOutput.components(separatedBy: "\n").first(where: { $0.hasPrefix("{") }),
           let data = line.data(using: .utf8),
           let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            title = info["title"] as? String ?? ""
            duration = Int(info["duration"] as? Double ?? 0)
        }

        if duration == 0, let ffprobe = Tools.locate("ffprobe") {
            let probe = try? Tools.run(ffprobe, [
                "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", file.path,
            ], timeout: 30)
            duration = Int(Double(probe?.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? "0") ?? 0)
        }

        return ["path": file.path, "title": title, "durationSeconds": duration]
    }

    private func extractAudio(from path: String) throws -> [String: Any] {
        guard let ffmpeg = Tools.locate("ffmpeg") else {
            throw NativeError("ffmpeg nicht gefunden. Installieren mit: brew install ffmpeg")
        }

        let source = URL(fileURLWithPath: path)
        let output = source.deletingLastPathComponent().appendingPathComponent("audio.ogg")

        // 16 kHz mono Opus: what every Whisper-compatible endpoint wants, and
        // roughly a fortieth of the bytes of the original audio track.
        let result = try Tools.run(ffmpeg, [
            "-y", "-i", path,
            "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "libopus", "-b:a", "24k",
            output.path,
        ], timeout: 900)

        guard result.status == 0, FileManager.default.fileExists(atPath: output.path) else {
            throw NativeError("Tonspur konnte nicht extrahiert werden: \(result.standardError.suffix(300))")
        }

        let size = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
        let token = StagedFileStore.shared.stage(output)

        return [
            "url": "app://localhost/staged/\(token)",
            "filename": "audio.ogg",
            "sizeBytes": size,
        ]
    }

    private func extractFrames(from path: String, interval: Int, maxFrames: Int) throws -> [String: Any] {
        guard let ffmpeg = Tools.locate("ffmpeg") else {
            throw NativeError("ffmpeg nicht gefunden. Installieren mit: brew install ffmpeg")
        }

        let source = URL(fileURLWithPath: path)
        let directory = source.deletingLastPathComponent().appendingPathComponent("frames", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let result = try Tools.run(ffmpeg, [
            "-y", "-i", path,
            // 640 px wide is enough for a vision model to describe a scene and
            // read most on-screen text, at a fraction of the tokens.
            "-vf", "fps=1/\(max(1, interval)),scale=640:-2",
            "-frames:v", String(maxFrames),
            "-q:v", "5",
            directory.appendingPathComponent("frame_%04d.jpg").path,
        ], timeout: 900)

        guard result.status == 0 else {
            throw NativeError("Einzelbilder konnten nicht extrahiert werden: \(result.standardError.suffix(300))")
        }

        let files = try FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "jpg" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        var frames: [[String: Any]] = []
        for (index, file) in files.enumerated() {
            guard let data = try? Data(contentsOf: file) else { continue }
            frames.append([
                // ffmpeg's first sampled frame sits at t=0, the next one one
                // interval later, and so on.
                "timestamp": index * interval,
                "dataUrl": "data:image/jpeg;base64,\(data.base64EncodedString())",
            ])
        }

        return ["frames": frames]
    }

    // MARK: - Bridge plumbing

    /// Adopts the title bar geometry the page just reported.
    private func applyDragRegions(_ body: [String: Any]) {
        guard let dragView = titleBarDragView, let container = dragView.superview else { return }

        let height = CGFloat(body["height"] as? Double ?? 48)
        dragView.frame = NSRect(
            x: 0,
            y: container.bounds.height - height,
            width: container.bounds.width,
            height: height
        )

        dragView.interactiveRects = (body["holes"] as? [[String: Any]] ?? []).map { hole in
            CGRect(
                x: CGFloat(hole["x"] as? Double ?? 0),
                y: CGFloat(hole["y"] as? Double ?? 0),
                width: CGFloat(hole["w"] as? Double ?? 0),
                height: CGFloat(hole["h"] as? Double ?? 0)
            )
        }
    }

    private func respond(to requestId: Int, with data: Any?) {
        send(response: ["ok": true, "data": data ?? NSNull()], to: requestId)
    }

    private func respond(to requestId: Int, error: String) {
        send(response: ["ok": false, "error": error], to: requestId)
    }

    private func send(response: [String: Any], to requestId: Int) {
        guard let json = try? JSONSerialization.data(withJSONObject: response, options: [.fragmentsAllowed]) else {
            let fallback = Data(#"{"ok":false,"error":"Antwort nicht serialisierbar"}"#.utf8)
            evaluate("(window.databaseStudio || window.graphStudio)?.__resolve?.(\(requestId), '\(fallback.base64EncodedString())');")
            return
        }
        evaluate("(window.databaseStudio || window.graphStudio)?.__resolve?.(\(requestId), '\(json.base64EncodedString())');")
    }

    private func evaluate(_ javaScript: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(javaScript, completionHandler: nil)
        }
    }

    private func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
        guard let data, let encoded = String(data: data, encoding: .utf8) else { return "''" }
        return String(encoded.dropFirst().dropLast())
    }

    // MARK: File input elements inside the web view

    /// The tabular and snapshot browser fallbacks use ordinary `<input
    /// type=file>` elements. WebKit asks its UI delegate to provide the native
    /// chooser, including directory and multiple-selection semantics.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncWindowFullscreenState()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        // The app itself is served over `app://`; anything else is a link the
        // user clicked and belongs in their browser, not in this window.
        if url.scheme == "app" {
            decisionHandler(.allow)
            return
        }

        if url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
}

// MARK: - Entry point

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(AppConfig.launchedInBackground ? .accessory : .regular)
application.run()
