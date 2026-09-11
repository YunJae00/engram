using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

internal static class ControlPolicy
{
    private static readonly Regex Sensitive = new Regex(@"\b(sign[ -]?in|log[ -]?in|password|passkey|credential|authentication|authenticate|verification code|security code|two.factor|multi.factor|mfa|terminal|command prompt|powershell|windows security|security settings|user account control|registry editor|task manager|credential manager|security policy)\b|로그인|비밀번호|암호|인증", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Dictionary<string, ushort[]> Keys = new Dictionary<string, ushort[]>(StringComparer.Ordinal)
    {
        { "Enter", new ushort[] { 13 } }, { "Tab", new ushort[] { 9 } }, { "Space", new ushort[] { 32 } },
        { "Backspace", new ushort[] { 8 } }, { "Delete", new ushort[] { 46 } },
        { "ArrowLeft", new ushort[] { 37 } }, { "ArrowUp", new ushort[] { 38 } },
        { "ArrowRight", new ushort[] { 39 } }, { "ArrowDown", new ushort[] { 40 } },
        { "Home", new ushort[] { 36 } }, { "End", new ushort[] { 35 } },
        { "PageUp", new ushort[] { 33 } }, { "PageDown", new ushort[] { 34 } },
        { "Control+A", new ushort[] { 17, 65 } }, { "Control+B", new ushort[] { 17, 66 } },
        { "Control+I", new ushort[] { 17, 73 } }, { "Control+U", new ushort[] { 17, 85 } },
        { "Control+F", new ushort[] { 17, 70 } },
        { "Shift+Tab", new ushort[] { 16, 9 } }, { "Control+Tab", new ushort[] { 17, 9 } },
        { "Control+Shift+Tab", new ushort[] { 17, 16, 9 } },
        { "F6", new ushort[] { 117 } }, { "Shift+F6", new ushort[] { 16, 117 } },
        { "Control+L", new ushort[] { 17, 76 } }, { "Control+N", new ushort[] { 17, 78 } },
        { "Control+H", new ushort[] { 17, 72 } },
        { "Control+Home", new ushort[] { 17, 36 } }, { "Control+End", new ushort[] { 17, 35 } },
        { "Control+ArrowLeft", new ushort[] { 17, 37 } }, { "Control+ArrowRight", new ushort[] { 17, 39 } },
        { "Shift+Home", new ushort[] { 16, 36 } }, { "Shift+End", new ushort[] { 16, 35 } },
        { "Shift+ArrowLeft", new ushort[] { 16, 37 } }, { "Shift+ArrowRight", new ushort[] { 16, 39 } },
        { "Shift+ArrowUp", new ushort[] { 16, 38 } }, { "Shift+ArrowDown", new ushort[] { 16, 40 } },
        { "Control+Shift+Home", new ushort[] { 17, 16, 36 } }, { "Control+Shift+End", new ushort[] { 17, 16, 35 } },
        { "Control+Shift+ArrowLeft", new ushort[] { 17, 16, 37 } }, { "Control+Shift+ArrowRight", new ushort[] { 17, 16, 39 } }
    };

    internal static bool IsSensitive(string value) { return value != null && Sensitive.IsMatch(value); }
    internal static bool PassivePointer(int message, bool injected) { return message == 0x200 && !injected; }
    internal static bool HoldKeyboard(bool controlling, uint key, bool injected) { return controlling && key != 27 && !injected; }
    internal static bool HoldMouse(bool controlling, bool pointing, int message, bool injected)
    { return controlling && !injected && (message != 0x200 || pointing); }
    internal static ushort[] Chord(string key)
    {
        ushort[] value;
        if (!Keys.TryGetValue(key, out value)) throw new ArgumentException("This key is not allowed for desktop control");
        return (ushort[])value.Clone();
    }
    internal static void Literal(string text)
    {
        if (string.IsNullOrEmpty(text) || text.Length > 2000) throw new ArgumentException("Text must contain 1 to 2000 characters");
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (char.IsControl(character)) throw new ArgumentException("Use an allowed key action for control characters");
            if (char.IsHighSurrogate(character))
            {
                if (++index >= text.Length || !char.IsLowSurrogate(text[index])) throw new ArgumentException("Invalid Unicode text");
            }
            else if (char.IsLowSurrogate(character)) throw new ArgumentException("Invalid Unicode text");
        }
    }
}
