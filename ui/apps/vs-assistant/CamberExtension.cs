using Microsoft.VisualStudio.Extensibility;

namespace Camber.Assistant
{
    [VisualStudioContribution]
    internal class CamberExtension : Extension
    {
        public override ExtensionConfiguration ExtensionConfiguration =>
            new ExtensionConfiguration() { RequiresInProcessHosting = true };
    }
}
