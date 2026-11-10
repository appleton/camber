using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    public static class IgnoredContext
    {
        public enum IgnoreTarget
        {
            Directory,
            File
        };

        public static Dictionary<IgnoreTarget, HashSet<Regex>> IGNORE_PATTERNS = new Dictionary<IgnoreTarget, HashSet<Regex>>()
        {
            { IgnoreTarget.File, new HashSet<Regex> {
                new Regex(@"\.obj$", RegexOptions.Compiled)
            } },
            { IgnoreTarget.Directory, new HashSet<Regex> {
                new Regex(@"^.git$", RegexOptions.Compiled),
                new Regex(@"^\.vs$", RegexOptions.Compiled),
                new Regex(@"^bin$", RegexOptions.Compiled) }
            }
        };
    }
}
