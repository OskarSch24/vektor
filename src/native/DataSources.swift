import Foundation

enum DataSources {
    static func read(_ params: [String: Any]) throws -> Any {
        guard let resources = Bundle.main.resourceURL else { throw NativeError("Datenlaufzeit nicht gefunden.") }
        let runtime = resources.appendingPathComponent("data-runtime")
        let node = runtime.appendingPathComponent("node")
        guard FileManager.default.isExecutableFile(atPath: node.path) else {
            throw NativeError("Datenlaufzeit fehlt. Bitte Vektor neu bauen.")
        }
        let input = try JSONSerialization.data(withJSONObject: params)
        let process = Process()
        let stdin = Pipe(), stdout = Pipe()
        process.executableURL = node
        process.arguments = [runtime.appendingPathComponent("cli.mjs").path]
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        DispatchQueue.global().async {
            try? stdin.fileHandleForWriting.write(contentsOf: input)
            try? stdin.fileHandleForWriting.close()
        }
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let result = try? JSONSerialization.jsonObject(with: output) as? [String: Any] else {
            throw NativeError("Datenquelle konnte nicht gelesen werden (Laufzeitstatus \(process.terminationStatus)).")
        }
        guard result["ok"] as? Bool == true, let data = result["data"] else {
            throw NativeError(result["error"] as? String ?? "Datenquelle konnte nicht gelesen werden.")
        }
        return data
    }
}
