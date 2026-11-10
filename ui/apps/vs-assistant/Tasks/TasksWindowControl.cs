using CefSharp;
using Camber.Assistant.HelperLSP;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Tasks
{
    internal class TasksWindowControl : WebViewControl
    {
        internal TasksWindowControl(CamberTaskDTO task, CamberTaskVersionDTO version)
            : base("tasks.html", browser => new TasksWebViewCommunicator(browser, task, version))
        {
        }
    }
}
