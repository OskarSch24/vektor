import Foundation
import Darwin

// MARK: - Project folders and Redis persistence artifacts

enum RedisArtifactFormat: String {
    case rdb
    case aofMultipart = "aof-multipart"
    case aofLegacy = "aof-legacy"
}

enum RedisArtifactStatus: String {
    case valid
    case incomplete
    case corrupt
    case unsupported
}

struct RedisArtifact {
    let id: String
    let projectID: String
    let name: String
    let anchorURL: URL
    let relativePath: String
    let format: RedisArtifactFormat
    let components: [URL]
    let size: Int64
    let modified: Double
    let status: RedisArtifactStatus
    let message: String?

    var json: [String: Any] {
        let componentURLs: [URL]
        if format == .aofMultipart {
            componentURLs = [anchorURL] + components
        } else {
            componentURLs = [anchorURL]
        }
        var payload: [String: Any] = [
            "id": id,
            "name": name,
            "path": anchorURL.path,
            "relativePath": relativePath,
            "size": size,
            "modified": modified,
            "format": format.rawValue,
            "kind": format == .rdb ? "snapshot" : "appendonly",
            "status": status.rawValue,
            "components": componentURLs.map { url in
                let values = try? url.resourceValues(forKeys: [.fileSizeKey])
                let lower = url.lastPathComponent.lowercased()
                let role = lower.hasSuffix(".manifest") ? "manifest"
                    : lower.hasSuffix(".base.rdb") || format == .rdb ? "base"
                    : lower.hasSuffix(".incr.aof") || format == .aofLegacy ? "incremental"
                    : "unknown"
                return [
                    "name": url.lastPathComponent,
                    "path": url.path,
                    "size": values?.fileSize ?? 0,
                    "role": role,
                ] as [String: Any]
            },
        ]
        if let message { payload["message"] = message }
        return payload
    }
}

enum VaultProjectScanner {
    private static let ignoredDirectories: Set<String> = [
        "node_modules", ".git", ".svn", ".hg", "Library", "DerivedData",
        "__pycache__", ".Trash", "dist", "build",
    ]
    private static let maxDepth = 12
    private static let maxFiles = 20_000

    /// File metadata captured by a project traversal. ProjectScanner feeds
    /// these entries into the Redis grouping pass so a unified project refresh
    /// does not need to crawl the same directory tree a second time.
    struct FileEntry {
        let url: URL
        let size: Int64
        let modified: Date
    }

    static func isArtifactFile(_ url: URL) -> Bool {
        let lower = url.lastPathComponent.lowercased()
        return lower.hasSuffix(".rdb")
            || lower.hasSuffix(".aof")
            || lower.hasSuffix(".aof.manifest")
    }

    static func shouldTraverseDirectory(named name: String) -> Bool {
        !ignoredDirectories.contains(name)
    }

    static func project(at root: URL) -> [String: Any] {
        var payload: [String: Any] = [
            "id": root.path,
            "name": root.lastPathComponent,
            "path": root.path,
        ]

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            payload["databases"] = []
            payload["databaseCount"] = 0
            payload["error"] = "Ordner nicht gefunden – wurde er verschoben oder gelöscht?"
            return payload
        }

        let result = artifacts(in: root)
        payload["databases"] = result.artifacts.map(\.json)
        payload["databaseCount"] = result.artifacts.count
        payload["truncated"] = result.truncated
        return payload
    }

    static func artifact(withID id: String, in roots: [String]) -> RedisArtifact? {
        for rootPath in roots {
            let result = artifacts(in: URL(fileURLWithPath: rootPath))
            if let artifact = result.artifacts.first(where: { $0.id == id }) { return artifact }
        }
        return nil
    }

    /// Validates an RDB chosen directly in Finder or the open panel. Project
    /// membership is useful for discovery, but must not be a prerequisite for
    /// opening a file the user explicitly selected.
    static func standaloneArtifact(at input: URL) -> RedisArtifact? {
        let url = input.standardizedFileURL
        guard url.pathExtension.lowercased() == "rdb" else { return nil }
        let values = try? url.resourceValues(forKeys: [
            .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
            .contentModificationDateKey,
        ])
        guard values?.isRegularFile == true,
              values?.isSymbolicLink != true,
              hasRDBHeader(url) else { return nil }

        let projectID = url.deletingLastPathComponent().path
        return RedisArtifact(
            id: artifactID(projectID: projectID, relativePath: url.lastPathComponent, format: .rdb),
            projectID: projectID,
            name: friendlyName(url.deletingPathExtension().lastPathComponent,
                               fallback: "Redis-Speicherstand"),
            anchorURL: url,
            relativePath: url.lastPathComponent,
            format: .rdb,
            components: [],
            size: Int64(values?.fileSize ?? 0),
            modified: (values?.contentModificationDate ?? .distantPast).timeIntervalSince1970 * 1000,
            status: .valid,
            message: nil
        )
    }

    static func artifacts(in root: URL) -> (artifacts: [RedisArtifact], truncated: Bool) {
        var files: [FileEntry] = []
        var visited = 0
        collectFiles(at: root, depth: 0, visited: &visited, files: &files)

        return artifacts(in: root, files: files, truncated: visited >= maxFiles)
    }

    /// Builds logical Redis databases from metadata gathered by an existing
    /// project walk. All manifest parsing, magic validation and multipart AOF
    /// grouping stays in this scanner; only the redundant directory traversal
    /// is skipped.
    static func artifacts(in root: URL, files: [FileEntry], truncated: Bool)
        -> (artifacts: [RedisArtifact], truncated: Bool) {

        let byPath = Dictionary(uniqueKeysWithValues: files.map { ($0.url.standardizedFileURL.path, $0) })
        var claimedPaths = Set<String>()
        var artifacts: [RedisArtifact] = []

        // Redis 7+ stores one logical AOF in a manifest plus base/incremental
        // parts. The parts must never appear as independent databases.
        for manifest in files where manifest.url.lastPathComponent.lowercased().hasSuffix(".aof.manifest") {
            let parsed = parseManifest(manifest, byPath: byPath)
            for component in parsed.components { claimedPaths.insert(component.standardizedFileURL.path) }
            claimedPaths.insert(manifest.url.standardizedFileURL.path)

            let componentEntries = parsed.components.compactMap { byPath[$0.standardizedFileURL.path] }
            let allEntries = [manifest] + componentEntries
            let size = allEntries.reduce(Int64(0)) { $0 + $1.size }
            let modified = allEntries.map(\.modified).max() ?? manifest.modified
            let relative = relativePath(of: manifest.url, to: root)
            let parent = manifest.url.deletingLastPathComponent()
            let displayRoot = parent.lastPathComponent.lowercased().contains("appendonly")
                ? parent.deletingLastPathComponent() : parent

            artifacts.append(RedisArtifact(
                id: artifactID(projectID: root.path, relativePath: relative, format: .aofMultipart),
                projectID: root.path,
                name: friendlyName(displayRoot.lastPathComponent, fallback: "AOF-Speicherstand"),
                anchorURL: manifest.url,
                relativePath: relative,
                format: .aofMultipart,
                components: parsed.components,
                size: size,
                modified: modified.timeIntervalSince1970 * 1000,
                status: parsed.status == .valid ? .unsupported : parsed.status,
                message: parsed.status == .valid
                    ? "Diese Sicherung wird erkannt, aber zum Schutz deines Macs nicht direkt gestartet. Öffne stattdessen den laufenden Speicher oder eine RDB-Sicherung."
                    : parsed.message
            ))
        }

        // A base/increment pair without its manifest is still useful evidence
        // in the overview, but it is not a loadable database. Group the parts
        // into one incomplete storage state instead of mislabelling base.rdb as
        // a standalone snapshot and incr.aof as a second database.
        var orphanGroups: [String: [FileEntry]] = [:]
        for entry in files where !claimedPaths.contains(entry.url.standardizedFileURL.path) {
            let lower = entry.url.lastPathComponent.lowercased()
            guard lower.range(
                of: #"\.aof\.\d+\.(base\.rdb|incr\.aof)$"#,
                options: .regularExpression
            ) != nil else { continue }
            orphanGroups[entry.url.deletingLastPathComponent().standardizedFileURL.path, default: []]
                .append(entry)
        }
        for (directoryPath, entries) in orphanGroups {
            let sorted = entries.sorted {
                $0.url.lastPathComponent.localizedStandardCompare($1.url.lastPathComponent) == .orderedAscending
            }
            guard let anchor = sorted.first else { continue }
            for entry in sorted { claimedPaths.insert(entry.url.standardizedFileURL.path) }
            let relative = relativePath(of: anchor.url, to: root)
            let directoryName = URL(fileURLWithPath: directoryPath).lastPathComponent
            artifacts.append(RedisArtifact(
                id: artifactID(projectID: root.path, relativePath: relative, format: .aofMultipart),
                projectID: root.path,
                name: friendlyName(directoryName, fallback: "AOF-Speicherstand"),
                anchorURL: anchor.url,
                relativePath: relative,
                format: .aofMultipart,
                components: sorted.dropFirst().map(\.url),
                size: sorted.reduce(Int64(0)) { $0 + $1.size },
                modified: (sorted.map(\.modified).max() ?? anchor.modified).timeIntervalSince1970 * 1000,
                status: .incomplete,
                message: "Die AOF-Beschreibung fehlt. Dieser Speicherstand ist nicht vollständig."
            ))
        }

        for entry in files {
            let path = entry.url.standardizedFileURL.path
            guard !claimedPaths.contains(path) else { continue }
            let ext = entry.url.pathExtension.lowercased()
            let format: RedisArtifactFormat
            let status: RedisArtifactStatus
            let message: String?

            if ext == "rdb" {
                format = .rdb
                if hasRDBHeader(entry.url) {
                    status = .valid; message = nil
                } else {
                    status = .corrupt
                    message = "Die Datei trägt die Endung .rdb, enthält aber keinen erkennbaren Redis-Speicherstand."
                }
            } else if ext == "aof" {
                format = .aofLegacy
                if looksLikeLegacyAOF(entry.url) {
                    status = .unsupported
                    message = "Diese Sicherung wird erkannt, aber zum Schutz deines Macs nicht direkt gestartet. Öffne stattdessen den laufenden Speicher oder eine RDB-Sicherung."
                } else {
                    status = .corrupt
                    message = "Die AOF-Datei ist leer oder hat kein erkennbares Redis-Format."
                }
            } else {
                continue
            }

            let relative = relativePath(of: entry.url, to: root)
            artifacts.append(RedisArtifact(
                id: artifactID(projectID: root.path, relativePath: relative, format: format),
                projectID: root.path,
                name: friendlyName(entry.url.deletingPathExtension().lastPathComponent,
                                   fallback: format == .rdb ? "Redis-Speicherstand" : "AOF-Speicherstand"),
                anchorURL: entry.url,
                relativePath: relative,
                format: format,
                components: [entry.url],
                size: entry.size,
                modified: entry.modified.timeIntervalSince1970 * 1000,
                status: status,
                message: message
            ))
        }

        artifacts.sort {
            if $0.status != $1.status { return $0.status == .valid }
            return $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending
        }
        return (artifacts, truncated)
    }

    private static func collectFiles(at directory: URL, depth: Int,
                                     visited: inout Int, files: inout [FileEntry]) {
        guard depth < maxDepth, visited < maxFiles else { return }
        let keys: Set<URLResourceKey> = [
            .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey,
            .fileSizeKey, .contentModificationDateKey,
        ]
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )) ?? []

        for url in contents {
            guard visited < maxFiles else { break }
            let values = try? url.resourceValues(forKeys: keys)
            if values?.isSymbolicLink == true { continue }
            if values?.isDirectory == true {
                guard !ignoredDirectories.contains(url.lastPathComponent) else { continue }
                collectFiles(at: url, depth: depth + 1, visited: &visited, files: &files)
                continue
            }
            guard values?.isRegularFile == true else { continue }
            visited += 1
            guard isArtifactFile(url) else { continue }
            files.append(FileEntry(
                url: url,
                size: Int64(values?.fileSize ?? 0),
                modified: values?.contentModificationDate ?? .distantPast
            ))
        }
    }

    private static func parseManifest(_ manifest: FileEntry, byPath: [String: FileEntry])
        -> (components: [URL], status: RedisArtifactStatus, message: String?) {
        guard let text = try? String(contentsOf: manifest.url, encoding: .utf8) else {
            return ([], .corrupt, "Das AOF-Verzeichnis kann nicht gelesen werden.")
        }

        var components: [URL] = []
        var missing: [String] = []
        var malformed = false
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let parts = rawLine.split(whereSeparator: \.isWhitespace).map(String.init)
            guard !parts.isEmpty else { continue }
            guard parts.count >= 2, parts[0] == "file" else { malformed = true; continue }
            let filename = parts[1]
            guard filename == URL(fileURLWithPath: filename).lastPathComponent,
                  !filename.contains(".."), !filename.contains("/") else {
                malformed = true; continue
            }
            let component = manifest.url.deletingLastPathComponent().appendingPathComponent(filename)
            let standardized = component.standardizedFileURL
            guard standardized.deletingLastPathComponent() == manifest.url.deletingLastPathComponent().standardizedFileURL else {
                malformed = true; continue
            }
            if byPath[standardized.path] != nil {
                components.append(standardized)
            } else {
                missing.append(filename)
            }
        }

        if malformed || components.isEmpty {
            return (components, .corrupt, "Das AOF-Manifest ist nicht vollständig lesbar.")
        }
        if !missing.isEmpty {
            let preview = missing.prefix(3).joined(separator: ", ")
            return (components, .incomplete, "Zur Sicherung fehlen Dateien: \(preview)")
        }
        return (components, .valid, nil)
    }

    private static func hasRDBHeader(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 9), data.count == 9 else { return false }
        let text = String(decoding: data, as: UTF8.self)
        return text.hasPrefix("REDIS") && text.dropFirst(5).allSatisfy(\.isNumber)
    }

    private static func looksLikeLegacyAOF(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 64) else { return false }
        if data.isEmpty { return true }
        if data.starts(with: Data("REDIS".utf8)) { return true }
        let text = String(decoding: data, as: UTF8.self)
        return text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("*")
    }

    private static func artifactID(projectID: String, relativePath: String,
                                   format: RedisArtifactFormat) -> String {
        "\(projectID)::\(relativePath)::\(format.rawValue)"
    }

    private static func relativePath(of url: URL, to root: URL) -> String {
        let rootPath = root.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(rootPath + "/") else { return url.lastPathComponent }
        return String(path.dropFirst(rootPath.count + 1))
    }

    private static func friendlyName(_ raw: String, fallback: String) -> String {
        let generic = ["dump", "vault", "appendonly", "appendonlydir"]
        guard !raw.isEmpty, !generic.contains(raw.lowercased()) else { return fallback }
        return raw.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
    }
}

// MARK: - Isolated, read-only snapshot sessions

final class SnapshotSessionManager {
    private struct Session {
        let id: String
        let artifactID: String
        let process: Process
        let directory: URL
        let port: Int
        let username: String
        let password: String
    }

    private var sessions: [String: Session] = [:]
    private let lock = NSLock()
    private let operationLock = NSLock()

    func open(_ artifact: RedisArtifact) throws -> [String: Any] {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard artifact.status == .valid else {
            throw RedisError(message: artifact.message ?? "Dieser Speicherstand ist unvollständig und kann nicht geöffnet werden.")
        }
        guard artifact.format == .rdb else {
            throw RedisError(message: "AOF-Sicherungen werden aus Sicherheitsgründen nicht als Befehlsfolge abgespielt.")
        }

        let sessionID = UUID().uuidString
        let sessionDirectory = try makeSessionDirectory(id: sessionID)
        var cleanupNeeded = true
        var processForCleanup: Process?
        defer {
            if cleanupNeeded {
                if let processForCleanup { stop(processForCleanup) }
                try? FileManager.default.removeItem(at: sessionDirectory)
            }
        }

        try requireSpace(for: artifact, at: sessionDirectory)
        let before = try signatures(of: [artifact.anchorURL] + artifact.components)
        try stage(artifact, in: sessionDirectory)
        let after = try signatures(of: [artifact.anchorURL] + artifact.components)
        guard before == after else {
            throw RedisError(message: "Der Speicherstand wurde während des Kopierens verändert. Bitte erneut versuchen.")
        }

        let port = try availablePort()
        let username = "viewer"
        let password = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let aclURL = sessionDirectory.appendingPathComponent("snapshot.acl")
        let acl = "user default off\nuser \(username) on >\(password) ~* &* +@read +ping +info +command +select +config|get +module|list\n"
        try Data(acl.utf8).write(to: aclURL, options: .atomic)

        let logURL = sessionDirectory.appendingPathComponent("redis.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let logHandle = try FileHandle(forWritingTo: logURL)
        let process = Process()
        processForCleanup = process
        process.executableURL = URL(fileURLWithPath: try LocalRedisService.executablePath())
        var arguments = [
            "--bind", "127.0.0.1",
            "--port", String(port),
            "--protected-mode", "yes",
            "--dir", sessionDirectory.path,
            // A persisted instance may have used more than Redis's default 16
            // logical databases. 4096 keeps ordinary archives loadable while
            // still placing a finite ceiling on hostile/corrupt inputs.
            "--databases", "4096",
            "--save", "",
            "--daemonize", "no",
            "--aclfile", aclURL.path,
            "--logfile", "",
        ]

        switch artifact.format {
        case .rdb:
            arguments += ["--dbfilename", "snapshot.rdb", "--appendonly", "no"]
        case .aofLegacy:
            arguments += [
                "--dbfilename", "unused.rdb", "--appendonly", "yes",
                "--appendfilename", "appendonly.aof", "--appenddirname", "appendonly",
                "--appendfsync", "no", "--auto-aof-rewrite-percentage", "0",
            ]
        case .aofMultipart:
            let appendFilename = artifact.anchorURL.lastPathComponent
                .replacingOccurrences(of: ".manifest", with: "")
            arguments += [
                "--dbfilename", "unused.rdb", "--appendonly", "yes",
                "--appendfilename", appendFilename, "--appenddirname", "appendonly",
                "--appendfsync", "no", "--auto-aof-rewrite-percentage", "0",
            ]
        }

        process.arguments = arguments
        process.standardOutput = logHandle
        process.standardError = logHandle
        do {
            try process.run()
        } catch {
            try? logHandle.close()
            throw RedisError(message: "Die Arbeitskopie konnte nicht gestartet werden: \(error.localizedDescription)")
        }

            var ready = false
            let readinessDeadline = Date().addingTimeInterval(90)
            repeat {
                if canPing(port: port, username: username, password: password) { ready = true; break }
                if !process.isRunning { break }
                Thread.sleep(forTimeInterval: 0.1)
            } while Date() < readinessDeadline
        try? logHandle.close()

        guard ready else {
            let details = (try? String(contentsOf: logURL, encoding: .utf8))?
                .split(whereSeparator: \.isNewline).suffix(2).joined(separator: " ") ?? ""
            let suffix = details.isEmpty ? "" : " Technische Details: \(details)"
            throw RedisError(message: "Der Speicherstand konnte nicht als Arbeitskopie geöffnet werden.\(suffix)")
        }

        let session = Session(
            id: sessionID, artifactID: artifact.id, process: process,
            directory: sessionDirectory, port: port, username: username, password: password
        )
        lock.lock(); sessions[sessionID] = session; lock.unlock()
        cleanupNeeded = false

        let databases = inspectDatabases(port: port, username: username, password: password)
        return [
            "sessionId": sessionID,
            "host": "127.0.0.1",
            "port": port,
            "db": (databases.first?["index"] as? Int) ?? 0,
            "name": artifact.name,
            "username": username,
            "password": password,
            "temporary": true,
            "immutable": true,
            "databases": databases,
        ]
    }

    func stopAll() {
        operationLock.lock()
        defer { operationLock.unlock() }
        lock.lock()
        let current = Array(sessions.values)
        sessions.removeAll()
        lock.unlock()
        for session in current {
            stop(session.process)
            try? FileManager.default.removeItem(at: session.directory)
        }
    }

    func stop(port: Int) {
        operationLock.lock()
        defer { operationLock.unlock() }
        lock.lock()
        let match = sessions.first { $0.value.port == port }
        if let match { sessions.removeValue(forKey: match.key) }
        lock.unlock()
        guard let session = match?.value else { return }
        stop(session.process)
        try? FileManager.default.removeItem(at: session.directory)
    }

    func stop(id: String) {
        operationLock.lock()
        defer { operationLock.unlock() }
        lock.lock()
        let session = sessions.removeValue(forKey: id)
        lock.unlock()
        guard let session else { return }
        stop(session.process)
        try? FileManager.default.removeItem(at: session.directory)
    }

    private func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        for _ in 0..<40 {
            if !process.isRunning { break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }

    private func requireSpace(for artifact: RedisArtifact, at directory: URL) throws {
        let available = try directory.resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey]
        ).volumeAvailableCapacityForImportantUsage ?? 0
        // Redis needs room beyond the source bytes for its process files and
        // possible AOF migration. Keep a modest fixed reserve as well.
        let required = max(artifact.size * 2, artifact.size + 64 * 1024 * 1024)
        guard available > required else {
            throw RedisError(message: "Für die geschützte Arbeitskopie ist nicht genügend freier Speicherplatz vorhanden.")
        }
    }

    private func stage(_ artifact: RedisArtifact, in directory: URL) throws {
        switch artifact.format {
        case .rdb:
            try FileManager.default.copyItem(
                at: artifact.anchorURL,
                to: directory.appendingPathComponent("snapshot.rdb")
            )
        case .aofLegacy:
            try FileManager.default.copyItem(
                at: artifact.anchorURL,
                to: directory.appendingPathComponent("appendonly.aof")
            )
        case .aofMultipart:
            let appendDirectory = directory.appendingPathComponent("appendonly", isDirectory: true)
            try FileManager.default.createDirectory(at: appendDirectory, withIntermediateDirectories: true)
            let files = [artifact.anchorURL] + artifact.components
            for source in files {
                let target = appendDirectory.appendingPathComponent(source.lastPathComponent)
                try FileManager.default.copyItem(at: source, to: target)
            }
        }
    }

    private func makeSessionDirectory(id: String) throws -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(AppConfig.bundleName, isDirectory: true)
            .appendingPathComponent("Snapshot Sessions", isDirectory: true)
        try FileManager.default.createDirectory(
            at: base, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let directory = base.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        return directory
    }

    private func signatures(of urls: [URL]) throws -> [String: String] {
        var result: [String: String] = [:]
        for url in Set(urls.map(\.standardizedFileURL)) {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else {
                throw RedisError(message: "Verknüpfte Sicherungsdateien werden aus Sicherheitsgründen nicht geöffnet.")
            }
            result[url.path] = "\(values.fileSize ?? -1):\(values.contentModificationDate?.timeIntervalSince1970 ?? -1)"
        }
        return result
    }

    private func availablePort() throws -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw RedisError(message: "Kein lokaler Vorschau-Port verfügbar.") }
        defer { Darwin.close(descriptor) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { throw RedisError(message: "Kein lokaler Vorschau-Port verfügbar.") }

        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        guard nameResult == 0 else { throw RedisError(message: "Kein lokaler Vorschau-Port verfügbar.") }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    private func canPing(port: Int, username: String, password: String) -> Bool {
        let connection = RedisConnection(config: RedisConfig(json: [
            "host": "127.0.0.1", "port": port,
            "username": username, "password": password, "timeoutMs": 500,
        ]))
        do {
            try connection.open(); defer { connection.close() }
            return try connection.send(["PING"]).stringValue == "PONG"
        } catch { return false }
    }

    private func inspectDatabases(port: Int, username: String, password: String) -> [[String: Any]] {
        let connection = RedisConnection(config: RedisConfig(json: [
            "host": "127.0.0.1", "port": port,
            "username": username, "password": password, "timeoutMs": 2000,
        ]))
        guard (try? connection.open()) != nil else { return [] }
        defer { connection.close() }
        guard let text = try? connection.send(["INFO", "keyspace"]).stringValue else { return [] }

        var databases: [[String: Any]] = []
        for line in text.split(whereSeparator: \.isNewline) where line.hasPrefix("db") {
            let halves = line.split(separator: ":", maxSplits: 1).map(String.init)
            guard halves.count == 2, let index = Int(halves[0].dropFirst(2)) else { continue }
            let values = Dictionary(uniqueKeysWithValues: halves[1].split(separator: ",").compactMap { pair -> (String, Int)? in
                let parts = pair.split(separator: "=", maxSplits: 1)
                guard parts.count == 2, let value = Int(parts[1]) else { return nil }
                return (String(parts[0]), value)
            })
            databases.append([
                "index": index,
                "keyCount": values["keys"] ?? 0,
                "expires": values["expires"] ?? 0,
            ])
        }
        return databases.sorted { ($0["index"] as? Int ?? 0) < ($1["index"] as? Int ?? 0) }
    }
}
