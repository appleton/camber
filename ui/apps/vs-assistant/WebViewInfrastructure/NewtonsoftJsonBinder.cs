using CefSharp.ModelBinding;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.WebViewInfrastructure
{
    public class NewtonsoftJsonBinder : IBinder
    {
        public object Bind(object obj, System.Type targetParamType)
        {
            // Somehow, we sometimes get an exception object passed in here; just pass it along.
            if (obj is Exception)
                return obj;
            var json = JsonConvert.SerializeObject(obj);
            return JsonConvert.DeserializeObject(json, targetParamType);
        }
    }
}
