import Foundation
import Security

/// Keychain read/write for the UI-WS bearer token so it isn't sitting in
/// plist files. Falls back to UserDefaults when Keychain is unavailable —
/// unsigned Debug/simulator builds carry no keychain entitlement and
/// SecItem* calls fail with errSecMissingEntitlement; persisting there is
/// still better than dropping the token every launch.
enum Keychain {
    private static let service = "ai.luna.ios"
    private static let fallbackPrefix = "luna.kc-fallback."

    static func read(account: String) -> String? {
        if let value = readKeychain(account: account) { return value }
        return UserDefaults.standard.string(forKey: fallbackPrefix + account)
    }

    static func save(_ value: String, account: String) {
        if !saveKeychain(value, account: account) {
            UserDefaults.standard.set(value, forKey: fallbackPrefix + account)
        }
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: fallbackPrefix + account)
    }

    private static func readKeychain(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            return String(data: data, encoding: .utf8)
        }
        if status != errSecItemNotFound {
            NSLog("[luna] Keychain read failed for %@ (OSStatus %d)", account, status)
        }
        return nil
    }

    private static func saveKeychain(_ value: String, account: String) -> Bool {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attrs: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        if status != errSecSuccess {
            NSLog("[luna] Keychain save failed for %@ (OSStatus %d) — falling back to UserDefaults", account, status)
            return false
        }
        UserDefaults.standard.removeObject(forKey: fallbackPrefix + account)
        return true
    }
}
