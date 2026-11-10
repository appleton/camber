using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

// General Information about an assembly is controlled through the following
// set of attributes. Change these attribute values to modify the information
// associated with an assembly.
[assembly: AssemblyTitle("Camber Assistant for Visual Studio")]
[assembly: AssemblyDescription("")]
[assembly: AssemblyConfiguration("")]
[assembly: AssemblyCompany("Camber")]
[assembly: AssemblyProduct("Camber Assistant")]
[assembly: AssemblyCopyright("Poolside")]
[assembly: AssemblyTrademark("")]
[assembly: AssemblyCulture("")]

// Setting ComVisible to false makes the types in this assembly not visible
// to COM components.  If you need to access a type in this assembly from
// COM, set the ComVisible attribute to true on that type.
[assembly: ComVisible(false)]

// Version information for an assembly consists of the following four values:
//
//      Major Version
//      Minor Version
//      Build Number
//      Revision
//
// You can specify all the values or you can default the Build and Revision Numbers
// by using the '*' as shown below:
// [assembly: AssemblyVersion("1.0.*")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

// Microsoft.VisualStudio.Extensibility.Sdk brings in Microsoft.Extensions.DependencyInjection 9.x,
// but VS 2022 may try to load an older version. Redirect any version up to 9.x to the one we ship.
[assembly: ProvideBindingRedirection(AssemblyName = "Microsoft.Extensions.DependencyInjection",
    OldVersionLowerBound = "0.0.0.0", OldVersionUpperBound = "9.0.0.0", NewVersion = "9.0.0.0",
    GenerateCodeBase = true)]
[assembly: ProvideBindingRedirection(AssemblyName = "Microsoft.Extensions.DependencyInjection.Abstractions",
    OldVersionLowerBound = "0.0.0.0", OldVersionUpperBound = "9.0.0.0", NewVersion = "9.0.0.0",
    GenerateCodeBase = true)]
