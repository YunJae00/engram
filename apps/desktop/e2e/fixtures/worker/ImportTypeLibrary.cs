using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;

internal sealed class ImportTypeLibrary : ITypeLibImporterNotifySink
{
    private readonly Dictionary<string, Assembly> assemblies = new Dictionary<string, Assembly>();

    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void LoadTypeLibEx(string file, int registration,
        out System.Runtime.InteropServices.ComTypes.ITypeLib library);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new ArgumentException("Expected a type library and output directory.");
            Directory.SetCurrentDirectory(Path.GetFullPath(args[1]));
            System.Runtime.InteropServices.ComTypes.ITypeLib library;
            LoadTypeLibEx(Path.GetFullPath(args[0]), 2, out library);
            new ImportTypeLibrary().Import(library, "MSTSCLib");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private Assembly Import(object library, string name)
    {
        Assembly existing;
        if (assemblies.TryGetValue(name, out existing)) return existing;
        var converter = new TypeLibConverter();
        var assembly = converter.ConvertTypeLibToAssembly(library, name + ".dll",
            TypeLibImporterFlags.ImportAsX64, this, null, null, name, null);
        assemblies.Add(name, assembly);
        assembly.Save(name + ".dll");
        return assembly;
    }

    public Assembly ResolveRef(object library)
    {
        return Import(library, Marshal.GetTypeLibName((System.Runtime.InteropServices.ComTypes.ITypeLib)library));
    }

    public void ReportEvent(ImporterEventKind kind, int code, string message)
    {
        if (kind == ImporterEventKind.ERROR_REFTOINVALIDTYPELIB) throw new InvalidOperationException(message);
    }
}
