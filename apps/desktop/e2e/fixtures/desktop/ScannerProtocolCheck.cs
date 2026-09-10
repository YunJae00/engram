using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;

internal static class ScannerProtocolCheck
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static MethodInfo Parse, Read;
    private static int Checks;
    private static void Check(bool condition, string message)
    { if (!condition) throw new InvalidOperationException(message); Checks++; }
    private static Dictionary<string, object> Response()
    {
        return new Dictionary<string, object> {
            { "id", 7 }, { "window", "123" }, { "pid", 456 }, { "started", "789" },
            { "complete", true }, { "password", false }, { "elapsedMs", 1.5 }, { "workingSetBytes", 1048576 }
        };
    }
    private static bool Invoke(Dictionary<string, object> response, out bool password)
    {
        var args = new object[] { Json.Serialize(response), 7, new IntPtr(123), 456, 789L, false, 0L };
        var complete = (bool)Parse.Invoke(null, args);
        password = (bool)args[5];
        Check((long)args[6] > 0, "Valid scanner memory accounting was lost");
        return complete;
    }
    private static void Reject(Action action, string label)
    {
        try { action(); }
        catch (TargetInvocationException error)
        {
            if (error.InnerException is InvalidOperationException || error.InnerException is ArgumentException
                || error.InnerException is IOException || error.InnerException is InvalidDataException) { Checks++; return; }
            throw;
        }
        throw new InvalidOperationException("Accepted invalid scanner protocol: " + label);
    }
    private static void Invalid(string key, object value)
    {
        var response = Response();
        response[key] = value;
        Reject(delegate { bool ignored; Invoke(response, out ignored); }, key + "=" + value);
    }
    private static int Main(string[] args)
    {
        if (args.Length != 1) return 2;
        try
        {
            var type = Assembly.LoadFrom(Path.GetFullPath(args[0])).GetType("PasswordScanBroker", true);
            Parse = type.GetMethod("ReadResponse", BindingFlags.Static | BindingFlags.NonPublic);
            Read = type.GetMethod("ReadLine", BindingFlags.Static | BindingFlags.NonPublic);
            Check(Parse != null && Read != null, "The actual scanner protocol methods are unavailable");
            bool password;
            Check(Invoke(Response(), out password) && !password, "A complete negative scan was rejected");
            var protectedResponse = Response(); protectedResponse["password"] = true;
            Check(Invoke(protectedResponse, out password) && password, "A complete positive scan was lost");
            var incomplete = Response(); incomplete["complete"] = false; incomplete["password"] = null;
            Check(!Invoke(incomplete, out password), "An incomplete scan became proof of safety");
            foreach (var pair in Response())
            {
                var missing = Response(); missing.Remove(pair.Key);
                Reject(delegate { bool ignored; Invoke(missing, out ignored); }, "missing " + pair.Key);
            }
            Invalid("id", 8); Invalid("id", "7"); Invalid("window", "124"); Invalid("window", 123);
            Invalid("pid", 457); Invalid("pid", "456"); Invalid("started", "790"); Invalid("started", 789);
            Invalid("complete", null); Invalid("complete", "true"); Invalid("complete", 1);
            Invalid("password", null); Invalid("password", "false"); Invalid("password", 0);
            Invalid("elapsedMs", -1); Invalid("elapsedMs", "1.5"); Invalid("elapsedMs", 2001);
            Invalid("workingSetBytes", 0); Invalid("workingSetBytes", -1); Invalid("workingSetBytes", "1048576");
            incomplete["password"] = false;
            Reject(delegate { bool ignored; Invoke(incomplete, out ignored); }, "incomplete with a boolean result");
            Check(Read.Invoke(null, new object[] { new StringReader("") }) == null, "EOF must not create a response");
            Check((string)Read.Invoke(null, new object[] { new StringReader("{}\n") }) == "{}", "A complete line changed");
            Reject(delegate { Read.Invoke(null, new object[] { new StringReader("{}") }); }, "incomplete trailing line");
            Reject(delegate { Read.Invoke(null, new object[] { new StringReader(new string('x', 1025) + "\n") }); }, "oversized response");
            Console.WriteLine("{\"protocolChecks\":" + Checks + "}");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
