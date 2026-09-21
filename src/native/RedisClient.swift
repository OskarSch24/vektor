import Foundation

/**
 A small RESP client — the half of Database Studio a web view cannot provide.

 Everything else in this app lives in the renderer, but Redis speaks a binary
 protocol over TCP and a WKWebView has no socket. So the connection lives here,
 and the page reaches it through the `redis` message handler. During
 `npm run dev` the same three operations come from the Vite bridge instead
 (dev/redisBridge.ts), which is why both sides serialise replies into the exact
 same JSON shape.

 The client speaks RESP2 and parses RESP3 as well. RESP2 is what a plain
 `redis-server` answers with, and every command works over it; the RESP3 types
 are handled because a user can type `HELLO 3` in the console, and everything
 after that has to stay readable rather than desynchronising the stream.
 */

// MARK: - Values

/// One reply, in the shape both transports agree on.
indirect enum RedisWire {
    case simple(String)
    case error(String)
    case int(Int64)
    /// `binary` marks a bulk string that is not valid UTF-8; `text` is then base64.
    case bulk(text: String, binary: Bool)
    case nilValue
    case array([RedisWire])
    case map([RedisWire])
    case set([RedisWire])
    case push([RedisWire])
    case double(String)
    case bool(Bool)
    case big(String)

    var json: Any {
        switch self {
        case .simple(let value): return ["t": "simple", "v": value]
        case .error(let value): return ["t": "error", "v": value]
        // Redis counters can exceed what a JavaScript number holds exactly;
        // anything past 2^53 travels as a string so no digits are invented.
        case .int(let value):
            return abs(value) <= 9_007_199_254_740_991
                ? ["t": "int", "v": value]
                : ["t": "big", "v": String(value)]
        case .bulk(let text, let binary):
            var payload: [String: Any] = ["t": "bulk", "v": text]
            if binary { payload["b"] = true }
            return payload
        case .nilValue: return ["t": "nil"]
        case .array(let items): return ["t": "array", "v": items.map { $0.json }]
        case .map(let items): return ["t": "map", "v": items.map { $0.json }]
        case .set(let items): return ["t": "set", "v": items.map { $0.json }]
        case .push(let items): return ["t": "push", "v": items.map { $0.json }]
        case .double(let value): return ["t": "double", "v": value]
        case .bool(let value): return ["t": "bool", "v": value]
        case .big(let value): return ["t": "big", "v": value]
        }
    }

    /// The text of a simple or bulk reply — used for the handshake checks.
    var stringValue: String? {
        switch self {
        case .simple(let value): return value
        case .bulk(let text, let binary): return binary ? nil : text
        default: return nil
        }
    }

    var errorText: String? {
        if case .error(let message) = self { return message }
        return nil
    }
}

struct RedisError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Configuration

struct RedisConfig {
    var host: String = "127.0.0.1"
    var port: UInt16 = 6379
    var username: String = ""
    var password: String = ""
    var database: Int = 0
    /// Applies to a single command, not to the connection as a whole.
    var timeout: TimeInterval = 30

    init(json: [String: Any]) {
        if let host = json["host"] as? String, !host.isEmpty { self.host = host }
        if let port = json["port"] as? Int, port > 0, port <= 65_535 { self.port = UInt16(port) }
        if let username = json["username"] as? String { self.username = username }
        if let password = json["password"] as? String { self.password = password }
        if let database = json["db"] as? Int, database >= 0 { self.database = database }
        if let timeout = json["timeoutMs"] as? Int, timeout > 0 {
            self.timeout = min(TimeInterval(timeout) / 1000, 600)
        }
    }
}

// MARK: - Connection

final class RedisConnection {
    private var descriptor: Int32 = -1
    private var buffer = Data()
    /// Commands are serialised: RESP has no request ids, so replies are matched
    /// by arrival order and two writers would hand each other the wrong answer.
    private let lock = NSLock()

    let config: RedisConfig
    private(set) var isOpen = false

    init(config: RedisConfig) {
        self.config = config
    }

    deinit { close() }

    // MARK: Opening

    func open() throws {
        var hints = addrinfo(
            ai_flags: 0,
            ai_family: AF_UNSPEC,
            ai_socktype: SOCK_STREAM,
            ai_protocol: IPPROTO_TCP,
            ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
        )

        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(config.host, String(config.port), &hints, &result)
        guard status == 0, let addresses = result else {
            throw RedisError(message: "\(config.host) konnte nicht aufgelöst werden: \(String(cString: gai_strerror(status)))")
        }
        defer { freeaddrinfo(addresses) }

        var lastError = "Verbindung fehlgeschlagen."
        var candidate = Optional(addresses)
        while let address = candidate {
            let fd = socket(address.pointee.ai_family, address.pointee.ai_socktype, address.pointee.ai_protocol)
            if fd >= 0 {
                var enabled: Int32 = 1
                // Without TCP_NODELAY every small command waits on Nagle's
                // algorithm, which turns an interactive console into a stutter.
                setsockopt(fd, Int32(IPPROTO_TCP), TCP_NODELAY, &enabled, socklen_t(MemoryLayout<Int32>.size))
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
                setTimeout(on: fd, seconds: config.timeout)

                if connect(fd, address.pointee.ai_addr, address.pointee.ai_addrlen) == 0 {
                    descriptor = fd
                    isOpen = true
                    try handshake()
                    return
                }
                lastError = String(cString: strerror(errno))
                Darwin.close(fd)
            }
            candidate = address.pointee.ai_next
        }

        throw RedisError(message: "\(config.host):\(config.port) nicht erreichbar — \(lastError)")
    }

    private func setTimeout(on fd: Int32, seconds: TimeInterval) {
        // `Int(0.5)` is zero, and `{0,0}` means *no* socket timeout on macOS.
        // Preserve the fractional part so readiness probes cannot block the
        // app indefinitely while a large snapshot is still loading.
        let wholeSeconds = floor(seconds)
        let microseconds = (seconds - wholeSeconds) * 1_000_000
        var tv = timeval(tv_sec: Int(wholeSeconds), tv_usec: Int32(microseconds))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// AUTH and SELECT belong to opening the connection: a session that silently
    /// stayed on database 0 would show a keyspace the user did not ask for.
    private func handshake() throws {
        if !config.password.isEmpty {
            let reply = config.username.isEmpty
                ? try send(["AUTH", config.password])
                : try send(["AUTH", config.username, config.password])
            if let message = reply.errorText {
                close()
                throw RedisError(message: "Anmeldung abgelehnt: \(message)")
            }
        }
        if config.database != 0 {
            let reply = try send(["SELECT", String(config.database)])
            if let message = reply.errorText {
                close()
                throw RedisError(message: "Datenbank \(config.database) nicht verfügbar: \(message)")
            }
        }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        if descriptor >= 0 { Darwin.close(descriptor) }
        descriptor = -1
        isOpen = false
        buffer.removeAll()
    }

    // MARK: Commands

    func send(_ arguments: [String]) throws -> RedisWire {
        lock.lock()
        defer { lock.unlock() }
        guard isOpen, descriptor >= 0 else {
            throw RedisError(message: "Die Verbindung ist geschlossen.")
        }

        try write(Self.encode(arguments))
        return try readReply()
    }

    /// Encodes a command as a RESP array of bulk strings — the form every Redis
    /// version accepts, including binary-safe arguments.
    static func encode(_ arguments: [String]) -> Data {
        var out = Data("*\(arguments.count)\r\n".utf8)
        for argument in arguments {
            let bytes = Data(argument.utf8)
            out.append(Data("$\(bytes.count)\r\n".utf8))
            out.append(bytes)
            out.append(Data("\r\n".utf8))
        }
        return out
    }

    private func write(_ data: Data) throws {
        var sent = 0
        try data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            while sent < data.count {
                let written = Darwin.send(descriptor, base.advanced(by: sent), data.count - sent, 0)
                if written <= 0 {
                    if errno == EINTR { continue }
                    isOpen = false
                    throw RedisError(message: "Senden fehlgeschlagen: \(String(cString: strerror(errno)))")
                }
                sent += written
            }
        }
    }

    /// Reads until one complete reply is in the buffer. Anything read beyond it
    /// stays for the next call — a pipelined server can answer faster than the
    /// caller asks.
    private func readReply() throws -> RedisWire {
        while true {
            if let parsed = try Self.parse(buffer, from: buffer.startIndex) {
                buffer.removeSubrange(buffer.startIndex..<parsed.end)
                return parsed.value
            }
            try fill()
        }
    }

    private func fill() throws {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let count = recv(descriptor, &chunk, chunk.count, 0)
        if count > 0 {
            buffer.append(contentsOf: chunk[0..<count])
            return
        }
        isOpen = false
        if count == 0 {
            throw RedisError(message: "Der Server hat die Verbindung geschlossen.")
        }
        if errno == EAGAIN || errno == EWOULDBLOCK {
            throw RedisError(message: "Zeitüberschreitung — der Server hat nicht geantwortet.")
        }
        throw RedisError(message: "Lesen fehlgeschlagen: \(String(cString: strerror(errno)))")
    }

    // MARK: Parsing

    private struct Parsed {
        let value: RedisWire
        /// Index just past this reply.
        let end: Data.Index
    }

    /// Returns nil while the reply is still incomplete.
    private static func parse(_ data: Data, from start: Data.Index) throws -> Parsed? {
        guard start < data.endIndex else { return nil }
        guard let lineEnd = findCRLF(data, from: data.index(after: start)) else { return nil }

        let marker = Character(UnicodeScalar(data[start]))
        let line = String(decoding: data[data.index(after: start)..<lineEnd], as: UTF8.self)
        let afterLine = data.index(lineEnd, offsetBy: 2)

        switch marker {
        case "+": return Parsed(value: .simple(line), end: afterLine)
        case "-": return Parsed(value: .error(line), end: afterLine)
        case ":": return Parsed(value: .int(Int64(line) ?? 0), end: afterLine)
        case ",": return Parsed(value: .double(line), end: afterLine)
        case "#": return Parsed(value: .bool(line == "t"), end: afterLine)
        case "(": return Parsed(value: .big(line), end: afterLine)
        case "_": return Parsed(value: .nilValue, end: afterLine)

        case "$", "=":
            guard let size = Int(line) else { throw RedisError(message: "Ungültige Längenangabe \"\(line)\".") }
            if size < 0 { return Parsed(value: .nilValue, end: afterLine) }
            let bodyEnd = data.index(afterLine, offsetBy: size, limitedBy: data.endIndex) ?? data.endIndex
            guard data.distance(from: afterLine, to: data.endIndex) >= size + 2 else { return nil }
            let bytes = data[afterLine..<bodyEnd]
            return Parsed(value: bulk(from: Data(bytes)), end: data.index(bodyEnd, offsetBy: 2))

        case "!":
            guard let size = Int(line), size >= 0 else { throw RedisError(message: "Ungültige Fehlerlänge.") }
            guard data.distance(from: afterLine, to: data.endIndex) >= size + 2 else { return nil }
            let bodyEnd = data.index(afterLine, offsetBy: size)
            return Parsed(
                value: .error(String(decoding: data[afterLine..<bodyEnd], as: UTF8.self)),
                end: data.index(bodyEnd, offsetBy: 2)
            )

        case "*", "~", ">", "%":
            guard let declared = Int(line) else { throw RedisError(message: "Ungültige Elementanzahl.") }
            if declared < 0 { return Parsed(value: .nilValue, end: afterLine) }
            // A map declares pairs; it arrives flattened as key, value, key, …
            let count = marker == "%" ? declared * 2 : declared
            var items: [RedisWire] = []
            items.reserveCapacity(count)
            var cursor = afterLine
            for _ in 0..<count {
                guard let item = try parse(data, from: cursor) else { return nil }
                items.append(item.value)
                cursor = item.end
            }
            switch marker {
            case "*": return Parsed(value: .array(items), end: cursor)
            case "~": return Parsed(value: .set(items), end: cursor)
            case ">": return Parsed(value: .push(items), end: cursor)
            default: return Parsed(value: .map(items), end: cursor)
            }

        default:
            // The stream is out of sync and there is no way to resynchronise;
            // the caller drops the connection rather than returning nonsense.
            throw RedisError(message: "Unbekannter RESP-Typ \"\(marker)\".")
        }
    }

    /// Valid UTF-8 travels as text because that is what the viewer displays;
    /// anything else is base64 rather than being mangled into U+FFFD.
    private static func bulk(from bytes: Data) -> RedisWire {
        if let text = String(data: bytes, encoding: .utf8) {
            return .bulk(text: text, binary: false)
        }
        return .bulk(text: bytes.base64EncodedString(), binary: true)
    }

    private static func findCRLF(_ data: Data, from start: Data.Index) -> Data.Index? {
        guard start < data.endIndex else { return nil }
        var index = start
        while index < data.index(before: data.endIndex) {
            if data[index] == 0x0D, data[data.index(after: index)] == 0x0A { return index }
            index = data.index(after: index)
        }
        return nil
    }
}

// MARK: - Registry

/// Keeps the open connections the renderer refers to by id.
final class RedisConnectionStore {
    private var connections: [String: RedisConnection] = [:]
    private let lock = NSLock()
    private var counter = 0

    func add(_ connection: RedisConnection) -> String {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        let id = "conn-\(counter)"
        connections[id] = connection
        return id
    }

    func get(_ id: String) -> RedisConnection? {
        lock.lock()
        defer { lock.unlock() }
        return connections[id]
    }

    @discardableResult
    func remove(_ id: String) -> RedisConfig? {
        lock.lock()
        let connection = connections.removeValue(forKey: id)
        lock.unlock()
        connection?.close()
        return connection?.config
    }

    func closeAll() {
        lock.lock()
        let all = connections.values
        connections.removeAll()
        lock.unlock()
        all.forEach { $0.close() }
    }
}
