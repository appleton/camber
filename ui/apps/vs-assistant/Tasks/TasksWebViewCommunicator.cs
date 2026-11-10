using CefSharp.Wpf;
using Newtonsoft.Json;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Tasks
{
    internal class TasksWebViewCommunicator : WebViewCommunicator
    {
        protected override string ColorThemeChangedMethod => "onColorThemeChange";

        internal TasksWebViewCommunicator(ChromiumWebBrowser browser, CamberTaskDTO task, CamberTaskVersionDTO version)
            : base(browser, $"this.CAMBER_INITIAL_TASK_STATE = {JsonConvert.SerializeObject(task)};\n" +
                  (version != null ? $"this.CAMBER_SELECTED_TASK_VERSION_ID = \"{version.id}\";\n" : ""))
        {
        }
    }
}
