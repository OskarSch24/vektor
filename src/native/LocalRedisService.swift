import Foundation
import Darwin

/**
 A private Redis instance used by Database Studio.

 This is backend infrastructure, not a separate workspace in the UI. When a
 backend client needs it, the service starts on demand, binds exclusively to
 loopback and stores its durable files in Database Studio's Application Support
 directory. Existing servers are never replaced: if port 6379 already speaks
 Redis, Database Studio simply uses it.
 */
enum LocalRedisService {
    private static let host = "127.0.0.1"
    private static let port = 6379

    static func ensureRunning() throws -> [String: Any] {
        if canPing() {
            return ["running": true, "started": false, "host": host, "port": port]
        }

        let executable = try executablePath()
        let migration = try migrateLegacyDataIfSafe()
        let directory = URL(fileURLWithPath: migration["directory"] as? String ?? AppConfig.localRedisDirectory.path)
        let log = directory.appendingPathComponent("redis.log").path
        let pid = directory.appendingPathComponent("redis.pid").path

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = [
            "--bind", host,
            "--port", String(port),
            "--protected-mode", "yes",
            "--dir", directory.path,
            "--dbfilename", "vault.rdb",
            "--appendonly", "yes",
            "--appendfsync", "everysec",
            "--appenddirname", "appendonly",
            "--pidfile", pid,
            "--logfile", log,
            "--daemonize", "yes",
        ]

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            throw RedisError(message: "Der lokale Speicher konnte nicht gestartet werden: \(error.localizedDescription)")
        }

        guard process.terminationStatus == 0 else {
            throw RedisError(message: "Der lokale Speicher konnte nicht gestartet werden. Details stehen in \(log)")
        }

        // daemonize returns before the child has necessarily opened its socket.
        for _ in 0..<50 {
            if canPing() {
                return ["running": true, "started": true, "host": host, "port": port]
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        throw RedisError(message: "Der lokale Speicher wurde gestartet, antwortet aber noch nicht. Details stehen in \(log)")
    }

    private static func canPing() -> Bool {
        let connection = RedisConnection(config: RedisConfig(json: [
            "host": host,
            "port": port,
            "timeoutMs": 500,
        ]))
        do {
            try connection.open()
            defer { connection.close() }
            return try connection.send(["PING"]).stringValue == "PONG"
        } catch {
            return false
        }
    }

    static func executablePath() throws -> String {
        let candidates = [
            "/opt/homebrew/bin/redis-server",
            "/usr/local/bin/redis-server",
        ]
        if let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return path
        }
        throw RedisError(message: "Die lokale Speicher-Komponente ist auf diesem Mac noch nicht installiert.")
    }

    /// Read-only hook used by diagnostics and cleanup verification.
    static func migrationStatus(fileManager: FileManager = .default) -> [String: Any] {
        let legacyExists = fileManager.fileExists(atPath: AppConfig.legacyLocalRedisDirectory.path)
        let currentExists = fileManager.fileExists(atPath: AppConfig.localRedisDirectory.path)
        let liveStoreProcess = hasLiveRedisPID(in: AppConfig.legacyLocalRedisDirectory, fileManager: fileManager)
            || hasLiveRedisPID(in: AppConfig.localRedisDirectory, fileManager: fileManager)
        return [
            "legacyDirectory": AppConfig.legacyLocalRedisDirectory.path,
            "legacyExists": legacyExists,
            "directory": AppConfig.localRedisDirectory.path,
            "currentExists": currentExists,
            "running": canPing(),
            "storeProcessRunning": liveStoreProcess,
        ]
    }

    /// Never moves a store while the loopback Redis endpoint is active. The
    /// next app launch retries after that process has stopped.
    static func migrateLegacyDataIfSafe(fileManager: FileManager = .default) throws -> [String: Any] {
        let portIsActive = canPing()
        let storeProcessIsActive = hasLiveRedisPID(in: AppConfig.legacyLocalRedisDirectory, fileManager: fileManager)
            || hasLiveRedisPID(in: AppConfig.localRedisDirectory, fileManager: fileManager)
        if portIsActive || storeProcessIsActive {
            var status = migrationStatus(fileManager: fileManager)
            status["state"] = "deferred-running"
            status["migrated"] = false
            return status
        }

        do {
            return try LocalRedisDataMigration.migrateIfNeeded(
                legacyDirectory: AppConfig.legacyLocalRedisDirectory,
                destinationDirectory: AppConfig.localRedisDirectory,
                fileManager: fileManager
            ).json
        } catch let error as NativeError {
            throw error
        } catch {
            throw RedisError(message: "Der lokale Speicherordner konnte nicht migriert werden: \(error.localizedDescription)")
        }
    }

    /// The local service writes its daemon PID beside the database. Checking it
    /// closes the short race where Redis has started but does not answer PING
    /// yet. A reused/stale PID merely defers migration, which is safer than
    /// moving files that might still be open.
    private static func hasLiveRedisPID(in directory: URL, fileManager: FileManager) -> Bool {
        let pidURL = directory.appendingPathComponent("redis.pid")
        guard let text = try? String(contentsOf: pidURL, encoding: .utf8),
              let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 1 else { return false }
        errno = 0
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
