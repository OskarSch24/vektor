#!/usr/bin/env python3
"""Isolated regression checks for the Vault -> Database Studio Redis migration."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
MIGRATION_SOURCE = ROOT / "src/native/LocalRedisDataMigration.swift"


HARNESS = r'''
import Foundation
import Darwin

struct NativeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let legacy = root.appendingPathComponent("Vault Studio/Local Store", isDirectory: true)
let destination = root.appendingPathComponent("Database Studio/Local Store", isDirectory: true)
do {
    let report = try LocalRedisDataMigration.migrateIfNeeded(
        legacyDirectory: legacy,
        destinationDirectory: destination
    )
    print(report.state.rawValue)
    print(report.directory.path)
} catch {
    fputs(error.localizedDescription + "\n", stderr)
    exit(2)
}
'''


def compile_harness(build_dir: Path) -> Path:
    main = build_dir / "main.swift"
    main.write_text(HARNESS, encoding="utf-8")
    binary = build_dir / "redis-migration-test"
    subprocess.run(
        ["xcrun", "swiftc", str(MIGRATION_SOURCE), str(main), "-o", str(binary)],
        check=True,
        cwd=ROOT,
    )
    return binary


def run(binary: Path, root: Path, expected_status: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([str(binary), str(root)], text=True, capture_output=True)
    assert result.returncode == expected_status, (result.stdout, result.stderr)
    return result


def write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="database-studio-redis-test-") as temporary:
        temporary_path = Path(temporary)
        binary = compile_harness(temporary_path)

        # A real-looking RDB plus multipart AOF directory moves as one unit.
        case = temporary_path / "legacy-only"
        legacy = case / "Vault Studio/Local Store"
        current = case / "Database Studio/Local Store"
        write(legacy / "vault.rdb", b"REDIS0011payload")
        write(legacy / "appendonly/appendonly.aof.1.base.rdb", b"base")
        first = run(binary, case)
        assert first.stdout.splitlines()[0] == "migrated"
        assert not legacy.exists()
        assert (current / "vault.rdb").read_bytes() == b"REDIS0011payload"
        assert (current / "appendonly/appendonly.aof.1.base.rdb").read_bytes() == b"base"
        assert os.stat(current).st_mode & 0o777 == 0o700

        # Retrying a completed migration does nothing.
        second = run(binary, case)
        assert second.stdout.splitlines()[0] == "alreadyCurrent"
        assert (current / "vault.rdb").read_bytes() == b"REDIS0011payload"

        # A harmless empty destination can be left by an earlier app launch.
        case = temporary_path / "empty-destination"
        legacy = case / "Vault Studio/Local Store"
        current = case / "Database Studio/Local Store"
        write(legacy / "appendonly.aof", b"*1\r\n$4\r\nPING\r\n")
        current.mkdir(parents=True)
        result = run(binary, case)
        assert result.stdout.splitlines()[0] == "migrated"
        assert not legacy.exists()
        assert (current / "appendonly.aof").exists()

        # Two populated stores are never merged or overwritten.
        case = temporary_path / "conflict"
        legacy = case / "Vault Studio/Local Store"
        current = case / "Database Studio/Local Store"
        write(legacy / "vault.rdb", b"legacy")
        write(current / "vault.rdb", b"current")
        result = run(binary, case, expected_status=2)
        assert "enthalten Daten" in result.stderr
        assert (legacy / "vault.rdb").read_bytes() == b"legacy"
        assert (current / "vault.rdb").read_bytes() == b"current"

        # An empty legacy shell is safely removed after the canonical store exists.
        case = temporary_path / "empty-legacy"
        legacy = case / "Vault Studio/Local Store"
        current = case / "Database Studio/Local Store"
        legacy.mkdir(parents=True)
        write(current / "vault.rdb", b"canonical")
        result = run(binary, case)
        assert result.stdout.splitlines()[0] == "removedEmptyLegacy"
        assert not legacy.exists()
        assert (current / "vault.rdb").read_bytes() == b"canonical"

        # With no prior store, only the canonical secure directory is created.
        case = temporary_path / "fresh"
        result = run(binary, case)
        assert result.stdout.splitlines()[0] == "created"
        assert not (case / "Vault Studio/Local Store").exists()
        assert (case / "Database Studio/Local Store").is_dir()

    app_source = (ROOT / "src/App.tsx").read_text(encoding="utf-8")
    vault_source = (ROOT / "src/vault/App.tsx").read_text(encoding="utf-8")
    keychain_source = (ROOT / "src/native/Keychain.swift").read_text(encoding="utf-8")
    service_source = (ROOT / "src/native/LocalRedisService.swift").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "Redis auf diesem Mac" not in app_source
    assert "localRedis" not in app_source
    assert "ConnectionModal" not in vault_source
    assert "ProjectOverview" not in vault_source
    assert "localStore" not in vault_source
    assert "migrateLegacyPasswordIfNeeded" in keychain_source
    assert "password(for: account, service: service) == legacy" in keychain_source
    assert "hasLiveRedisPID" in service_source
    assert 'status["state"] = "deferred-running"' in service_source
    assert "| Redis live |" not in readme

    print("local Redis migration and backend-only UI contract: ok")


if __name__ == "__main__":
    main()
