import AppKit

@main struct ObservationChecks {
    static func main() {
        precondition(protectedApplication("com.apple.systempreferences"))
        precondition(!protectedApplication("com.kakao.KakaoTalkMac"))
        assert(transparentGroup(role: "AXGroup", name: "", value: "", identifier: "", actionable: false))
        assert(!transparentGroup(role: "AXGroup", name: "Inbox", value: "", identifier: "", actionable: false))
        assert(!transparentGroup(role: "AXGroup", name: "", value: "", identifier: "inbox", actionable: false))
        assert(!transparentGroup(role: "AXGroup", name: "", value: "", identifier: "", actionable: true))
        assert(!transparentGroup(role: "AXButton", name: "", value: "", identifier: "", actionable: false))
        let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("Names-" + UUID().uuidString + ".app")
        defer { try? FileManager.default.removeItem(at: root) }
        let resources = root.appendingPathComponent("Contents/Resources/ko.lproj")
        try! FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let info: [String: Any] = ["CFBundleIdentifier": "test.localized.app", "CFBundleName": "KakaoTalk", "CFBundlePackageType": "APPL", "CFBundleDevelopmentRegion": "en"]
        try! PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: root.appendingPathComponent("Contents/Info.plist"))
        let localized = "\u{CE74}\u{CE74}\u{C624}\u{D1A1}"
        try! ("\"CFBundleDisplayName\" = \"" + localized + "\";").write(to: resources.appendingPathComponent("InfoPlist.strings"), atomically: true, encoding: .utf16)
        assert(appAliases(url: root).contains(localized))
        assert(appAliases(url: root).contains("KakaoTalk"))
        print("PASS transparent container identity and localized app names")
    }
}
