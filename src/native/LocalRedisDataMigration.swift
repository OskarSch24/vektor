import Foundation

/**
 Moves the durable Redis store from Vault Studio's Application Support folder
 into Database Studio's folder.

 Both locations are on the same user volume, so `moveItem` is an atomic rename:
 Redis never sees a half-copied RDB or multipart AOF. If both locations contain
 data, the migration deliberately stops instead of guessing which database is
 authoritative. Retrying after a successful move is a no-op.
 */
enum LocalRedisDataMigration {
    enum State: String {
        case created
        case migrated
        case alreadyCurrent
        case removedEmptyLegacy
    }

    struct Report {
        let state: State
        let directory: URL

        var json: [String: Any] {
            [
                "state": state.rawValue,
                "directory": directory.path,
                "migrated": state == .migrated || state == .removedEmptyLegacy,
            ]
        }
    }

    static func migrateIfNeeded(
        legacyDirectory: URL,
        destinationDirectory: URL,
        fileManager: FileManager = .default
    ) throws -> Report {
        let legacy = legacyDirectory.standardizedFileURL
        let destination = destinationDirectory.standardizedFileURL

        guard legacy.path != destination.path else {
            throw NativeError("Alter und neuer Redis-Speicherordner sind identisch.")
        }

        let legacyExists = fileManager.fileExists(atPath: legacy.path)
        let destinationExists = fileManager.fileExists(atPath: destination.path)

        if legacyExists { try requirePlainDirectory(legacy, label: "Der alte Redis-Speicher", fileManager: fileManager) }
        if destinationExists { try requirePlainDirectory(destination, label: "Der neue Redis-Speicher", fileManager: fileManager) }

        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        if !legacyExists {
            if !destinationExists {
                try fileManager.createDirectory(
                    at: destination,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
                return Report(state: .created, directory: destination)
            }
            try secure(destination, fileManager: fileManager)
            return Report(state: .alreadyCurrent, directory: destination)
        }

        if destinationExists {
            let legacyIsEmpty = try isEmpty(legacy, fileManager: fileManager)
            let destinationIsEmpty = try isEmpty(destination, fileManager: fileManager)

            if legacyIsEmpty && !destinationIsEmpty {
                // There is no legacy payload left to preserve. Removing only
                // the empty shell completes an interrupted/manual migration.
                try fileManager.removeItem(at: legacy)
                try secure(destination, fileManager: fileManager)
                return Report(state: .removedEmptyLegacy, directory: destination)
            }

            guard destinationIsEmpty else {
                throw NativeError(
                    "Alter und neuer Redis-Speicher enthalten Daten. Vektor verschiebt nichts, damit kein Speicherstand überschrieben wird."
                )
            }

            // An empty destination is commonly left by an earlier app launch.
            // Deleting it is safe; the authoritative legacy directory remains
            // untouched until the subsequent atomic rename succeeds.
            try fileManager.removeItem(at: destination)
        }

        do {
            try fileManager.moveItem(at: legacy, to: destination)
        } catch {
            throw NativeError("Der lokale Redis-Speicher konnte nicht verschoben werden: \(error.localizedDescription)")
        }

        try requirePlainDirectory(destination, label: "Der migrierte Redis-Speicher", fileManager: fileManager)
        try secure(destination, fileManager: fileManager)
        return Report(state: .migrated, directory: destination)
    }

    private static func requirePlainDirectory(_ url: URL, label: String, fileManager: FileManager) throws {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw NativeError("\(label) ist kein normaler Ordner: \(url.path)")
        }
    }

    private static func isEmpty(_ url: URL, fileManager: FileManager) throws -> Bool {
        try fileManager.contentsOfDirectory(atPath: url.path).isEmpty
    }

    private static func secure(_ url: URL, fileManager: FileManager) throws {
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }
}
