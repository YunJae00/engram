import AppKit
import ApplicationServices

let textChunkUnits = 20
let typedMismatch = "The field does not hold the typed text"
let typedUnread = "The field could not be read back after typing"

func textChunks(_ value: String) throws -> [String] {
    var chunks: [String] = [], chunk = ""
    for character in value {
        let units = String(character).utf16.count
        guard units <= textChunkUnits else { throw DesktopFailure("Text contains a character too long to insert") }
        if chunk.utf16.count + units > textChunkUnits { chunks.append(chunk); chunk = "" }
        chunk.append(character)
    }
    if !chunk.isEmpty { chunks.append(chunk) }
    return chunks
}

func typedChunks(_ raw: Any?, joining value: String) throws -> [String] {
    guard let chunks = raw as? [String], (1...2000).contains(chunks.count),
          chunks.allSatisfy({ (1...textChunkUnits).contains($0.utf16.count) }),
          chunks.joined().unicodeScalars.elementsEqual(value.unicodeScalars) else { throw DesktopFailure("Invalid text chunks") }
    return chunks
}

func selectedRange(_ element: AXUIElement) -> CFRange? {
    guard let raw = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(raw as! AXValue, .cfRange, &range) ? range : nil
}

extension DesktopHost {
    // Inserts without per-character key events so an active input method cannot split or merge Hangul.
    func insertText(_ element: AXUIElement, _ chunks: [String], ready: () throws -> Void, post: (CGEvent?, CGEvent?) throws -> Void) throws -> String {
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue {
            try ready()
            if AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, chunks.joined() as CFString) == .success { return "selected-text" }
        }
        // Setting the selection unmarks any open composition; without it the keys could merge into that composition.
        guard var range = selectedRange(element), let selection = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection) == .success else {
            throw DesktopFailure("The open input composition could not be ended safely. Nothing was typed")
        }
        for chunk in chunks {
            try ready()
            let units = Array(chunk.utf16)
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            units.withUnsafeBufferPointer { buffer in
                down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
            }
            try post(down, up)
        }
        return "keys"
    }

    func verifyInserted(_ element: AXUIElement, value: String, before: String, range: CFRange?, strategy: String) throws -> [String: Any] {
        let original = before as NSString
        let caret = range.flatMap { $0.location >= 0 && $0.length >= 0 && $0.location + $0.length <= original.length ? NSRange(location: $0.location, length: $0.length) : nil }
            ?? NSRange(location: original.length, length: 0)
        let expected = original.replacingCharacters(in: caret, with: value).precomposedStringWithCanonicalMapping
        var after: String?
        for _ in 0..<5 {
            usleep(100_000)
            after = attribute(element, kAXValueAttribute) as? String
            if after?.precomposedStringWithCanonicalMapping == expected { return ["strategy": strategy, "expected": expected, "landed": after!] }
        }
        guard let landed = after else { throw DesktopFailure("\(typedUnread) (\(strategy)). Look at the field before saying it is done; do not send") }
        throw DesktopFailure("\(typedMismatch) (\(strategy)). It now reads: \"\(String(landed.suffix(200)))\". Tell the person what landed; do not type it again or send")
    }
}
