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
        { "PageUp", new ushort[] { 33 } }, { "PageDown", new ushort[] { 34 } }
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
