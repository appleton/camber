using Microsoft.VisualStudio.Utilities;
using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant
{
    public static class CamberFileMarkdownRegistration
    {
        [Export(typeof(FileExtensionToContentTypeDefinition))]
        [ContentType("vs-markdown")]
        [FileExtension(".poolside")]
        public static FileExtensionToContentTypeDefinition CamberFileExtension;
    }
}
