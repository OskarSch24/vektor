import Foundation
import Security

/**
 Passwords for saved connections.

 The rest of a saved connection — name, host, port, database — is ordinary
 preference data and lives in UserDefaults. The password does not: that file is
 a plist in the user's Library, readable by every process running as this user
 and picked up by any backup or sync that walks the folder. The keychain is the
 one place on macOS that is actually meant for this.
 */
enum Keychain {
    private static let service = "com.oskarschiermeister.databasestudio"
    private static let legacyService = "com.oskarschiermeister.vaultstudio"

    @discardableResult
    static func save(password: String, for account: String) -> Bool {
        guard !password.isEmpty else {
            // An explicit empty password is an explicit deletion. Clearing
            // both services prevents the legacy fallback from resurrecting it.
            delete(account: account, service: service)
            delete(account: account, service: legacyService)
            return true
        }

        guard write(password: password, for: account, service: service) else { return false }
        // Only remove the old credential after reading the new one back. The
        // old app is retired, so keeping a duplicate would be stale secret data.
        delete(account: account, service: legacyService)
        return true
    }

    /**
     Copies an existing Vault Studio password into Database Studio's Keychain
     service and removes the old item only after byte-for-byte verification.
     The operation is safe to call on every launch.
     */
    @discardableResult
    static func migrateLegacyPasswordIfNeeded(for account: String) -> Bool {
        let current = password(for: account, service: service)
        let legacy = password(for: account, service: legacyService)

        if let current {
            if legacy == current { delete(account: account, service: legacyService) }
            // A differing current credential is authoritative. Preserve the
            // conflicting legacy item for manual recovery instead of deleting it.
            return legacy == nil || legacy == current
        }

        guard let legacy else { return true }
        guard write(password: legacy, for: account, service: service),
              password(for: account, service: service) == legacy else { return false }
        delete(account: account, service: legacyService)
        return true
    }

    static func password(for account: String) -> String {
        _ = migrateLegacyPasswordIfNeeded(for: account)
        return password(for: account, service: service)
            ?? password(for: account, service: legacyService)
            ?? ""
    }

    private static func write(password passwordValue: String, for account: String, service: String) -> Bool {
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let values: [String: Any] = [
            kSecValueData as String: Data(passwordValue.utf8),
            // The app reads this while it runs, never in the background before
            // first unlock, so the strictest sensible protection applies.
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        // Accessibility is set when the item is created. Updating only the
        // secret works across older macOS versions that reject accessibility
        // changes in `SecItemUpdate`.
        let updateValues: [String: Any] = [kSecValueData as String: Data(passwordValue.utf8)]
        let update = SecItemUpdate(identity as CFDictionary, updateValues as CFDictionary)
        if update == errSecSuccess {
            return password(for: account, service: service) == passwordValue
        }
        guard update == errSecItemNotFound else { return false }

        var addition = identity
        values.forEach { addition[$0.key] = $0.value }
        return SecItemAdd(addition as CFDictionary, nil) == errSecSuccess
            && password(for: account, service: service) == passwordValue
    }

    private static func password(for account: String, service: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let password = String(data: data, encoding: .utf8) else { return nil }
        return password
    }

    static func delete(account: String) {
        delete(account: account, service: service)
        delete(account: account, service: legacyService)
    }

    private static func delete(account: String, service: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
