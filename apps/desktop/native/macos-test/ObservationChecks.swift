import AppKit

@main struct ObservationChecks {
    static func main() {
        assert(transparentGroup(role: "AXGroup", name: "", value: "", identifier: "", actionable: false))
        assert(!transparentGroup(role: "AXGroup", name: "Inbox", value: "", identifier: "", actionable: false))
        assert(!transparentGroup(role: "AXGroup", name: "", value: "", identifier: "inbox", actionable: false))
        assert(!transparentGroup(role: "AXGroup", name: "", value: "", identifier: "", actionable: true))
        assert(!transparentGroup(role: "AXButton", name: "", value: "", identifier: "", actionable: false))
        print("PASS transparent container identity checks")
    }
}
