using CefSharp;
using CefSharp.Handler;
using Microsoft.VisualStudio.OLE.Interop;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.WebViewInfrastructure
{
    internal class WebViewRequestHandler : RequestHandler
    {
        private string setupHTML;

        internal WebViewRequestHandler(string setupHTML)
        {
            this.setupHTML = setupHTML;
        }

        protected override bool OnBeforeBrowse(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request, bool userGesture, bool isRedirect)
        {
            // If it's a request initiated by the user, then open it in their browser.
            if (userGesture)
            {
                var url = request?.Url;
                if (url != null)
                {
                    Util.OpenUrlInBrowser(url);
                    return true;
                }
            }
            return base.OnBeforeBrowse(chromiumWebBrowser, browser, frame, request, userGesture, isRedirect);
        }

        protected override IResourceRequestHandler GetResourceRequestHandler(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request, bool isNavigation, bool isDownload, string requestInitiator, ref bool disableDefaultHandling)
        {
            // We treat requests to camber-app://app/... specially, serving them from
            // the resources.
            var url = request?.Url;
            if (url != null)
            {
                var parsed = new Uri(url);
                if (parsed.Scheme == "camber-app" && parsed.Host == "app")
                {
                    return new WebViewResourceRequestHandler(parsed.AbsolutePath, setupHTML);
                }
            }

            return base.GetResourceRequestHandler(chromiumWebBrowser, browser, frame, request, isNavigation, isDownload, requestInitiator, ref disableDefaultHandling);
        }
    }

    internal class WebViewResourceRequestHandler : ResourceRequestHandler
    {
        private string path;
        private string setupHTML;

        public WebViewResourceRequestHandler(string path, string setupHTML)
        {
            this.path = path;
            this.setupHTML = setupHTML;
        }

        protected override IResourceHandler GetResourceHandler(IWebBrowser chromiumWebBrowser, IBrowser browser, IFrame frame, IRequest request)
        {
            var assemblyPath = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            var filePath = Path.Combine(assemblyPath, "app", "dist", Path.Combine(path.Split('/')));
            try
            {
                var mimeType = GetMimeType();
                if (mimeType == "text/html")
                {
                    // It's the HTML file of the application; inject the setup script.
                    var html = File.ReadAllText(filePath);
                    var headIndex = html.IndexOf("<head>") + "<head>".Length;
                    return ResourceHandler.FromString(html.Substring(0, headIndex) +
                            setupHTML +
                            html.Substring(headIndex));
                }
                else
                {
                    return ResourceHandler.FromByteArray(File.ReadAllBytes(filePath), mimeType);
                }
            }
            catch (IOException)
            {
                return base.GetResourceHandler(chromiumWebBrowser, browser, frame, request);
            }
        }

        private string GetMimeType() => path.Split('.').Last() switch
        {
            "html" => "text/html",
            "js" => "text/javascript",
            "css" => "text/css",
            "png" => "image/png",
            "svg" => "image/svg+xml",
            "wasm" => "application/wasm",
            _ => "application/octet-stream",
        };
    }
}
