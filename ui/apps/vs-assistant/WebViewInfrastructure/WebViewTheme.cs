using Microsoft.VisualStudio;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.OLE.Interop;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Camber.Assistant.WebViewInfrastructure
{
    internal static class WebViewTheme
    {
        internal static string GetThemeInitializationCSS()
        {
            var declarations = string.Join(";\n", BuildTheme().Select(style => $"--{style.Key}: {style.Value}"));
            return $@"
                :root {{
                    {declarations}
                    --editor-font-size: 13px;
                    --editor-line-height: 20px;
                }}
                body {{
                    background-color: var(--psx-chrome);
                    color: var(--psx-foreground-primary);
                    font-size: 13px;
                    line-height: 1.5;
                }}
                ::-webkit-scrollbar {{
                    width: 12px;
                    height: 12px;
                }}
                ::-webkit-scrollbar-track {{
                    background-color: var(--vs-scroll-background);
                }}
                ::-webkit-scrollbar-thumb {{
                    background-color: var(--vs-scroll-thumb);
                }}
            ";
        }

        internal static string GetThemeUpdateJavaScript()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var updates = string.Join(";\n", BuildTheme().Select(style => $"root.style.setProperty('--{style.Key}', '{style.Value}')"));
            var (oldSyntaxClass, newSyntaxClass) = IsDark()? ("psx-light", "psx-dark") : ("psx-dark", "psx-light");
            return $@"
                var root = document.documentElement;
                {updates};
                document.body.classList.remove('{oldSyntaxClass}');
                document.body.classList.add('{newSyntaxClass}');
            ";
        }

        private static Dictionary<string, string> BuildTheme()
        {
            // Tip: https://keyoti.com/blog/visual-of-the-actual-colours-in-visual-studios-environmentcolors/ has
            // a really handy chart of all the colors available in here and what they are in some common themes.
            // It does not seem fully accurate, or at least not for VS 2022.
            var isDark = IsDark();
            var editorColors = GetEditorColors(isDark);
            return new Dictionary<string, string>
            {
                { "psx-font-mono", "\"" + (GetDefaultEditorFontName() ?? "Consolas") + "\"" },

                { "psx-foreground-primary", ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },
                { "psx-foreground-secondary", ToHexColor(editorColors.editorForeground) ?? ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },
                { "psx-foreground-tertiary", ThemeColor(EnvironmentColors.ToolWindowTabTextColorKey) },

                { "psx-chrome", ThemeColor(EnvironmentColors.ToolWindowBackgroundColorKey) },
                { "psx-chrome-hover", ThemeColor(EnvironmentColors.MainWindowButtonHoverActiveColorKey) },
                { "psx-chrome-active", ThemeColor(EnvironmentColors.MainWindowButtonDownColorKey) },

                { "psx-panel", ThemeColor(EnvironmentColors.ComboBoxBackgroundColorKey) },
                { "psx-border", ThemeColor(EnvironmentColors.ComboBoxBorderColorKey) },
                { "psx-focus", ThemeColor(EnvironmentColors.ComboBoxFocusedBorderColorKey) },
                { "psx-link", ThemeColor(EnvironmentColors.ControlLinkTextColorKey) },

                { "psx-bubble-background", ThemeColor(isDark ? EnvironmentColors.VizSurfaceStrongBlueDarkColorKey : EnvironmentColors.VizSurfaceStrongBlueLightColorKey) },
                { "psx-bubble-foreground", ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },

                { "psx-button-primary-foreground", ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },
                { "psx-button-primary-background", ThemeColor(isDark ? EnvironmentColors.VizSurfaceStrongBlueDarkColorKey : EnvironmentColors.VizSurfaceStrongBlueLightColorKey) },
                { "psx-button-primary-hover-background", ThemeColor(isDark ? EnvironmentColors.VizSurfaceStrongBlueDarkColorKey : EnvironmentColors.VizSurfaceStrongBlueLightColorKey) },
                { "psx-button-primary-border", ThemeColor(isDark ? EnvironmentColors.VizSurfaceStrongBlueDarkColorKey : EnvironmentColors.VizSurfaceStrongBlueLightColorKey) },
                { "psx-button-primary-hover-border", ThemeColor(isDark ? EnvironmentColors.VizSurfaceStrongBlueDarkColorKey : EnvironmentColors.VizSurfaceStrongBlueLightColorKey) },
                { "psx-button-secondary-foreground", ThemeColor(EnvironmentColors.ButtonTextColorKey) },
                { "psx-button-secondary-background", ThemeColor(EnvironmentColors.DockTargetButtonBackgroundBeginColorKey) },
                { "psx-button-secondary-hover-background", ThemeColor(EnvironmentColors.DockTargetButtonBackgroundBeginColorKey) },
                { "psx-button-secondary-border", ThemeColor(EnvironmentColors.DockTargetButtonBorderColorKey) },
                { "psx-button-secondary-hover-border", ThemeColor(EnvironmentColors.DockTargetButtonBorderColorKey) },

                { "psx-checkbox-background", ThemeColor(EnvironmentColors.ComboBoxFocusedBackgroundColorKey) },
                { "psx-checkbox-border", ThemeColor(EnvironmentColors.ComboBoxBorderColorKey) },
                { "psx-checkbox-foreground", ThemeColor(EnvironmentColors.ComboBoxTextColorKey) },

                { "psx-editor-background", ToHexColor(editorColors.editorBackground) },
                { "psx-editor-gutter-alternative", ToHexColor(editorColors.gutterBackground) },
                { "psx-editor-gutter-background", ToHexColor(editorColors.gutterBackground) },
                { "psx-editor-info-foreground", ThemeColor(isDark ? EnvironmentColors.VizSurfaceStrongBlueLightColorKey : EnvironmentColors.VizSurfaceStrongBlueDarkColorKey) },
                { "psx-editor-line-highlight-border", ToHexColor(editorColors.lineHighlightBorder) },
                { "psx-editor-line-number-foreground", ToHexColor(editorColors.lineNumber) },
                { "psx-editor-selection-background", ToHexColor(editorColors.selectionBackground) },
                { "psx-editor-selection-foreground", ToHexColor(editorColors.selectionForeground) },
                { "psx-diff-insert", ToHexColor(editorColors.diffInsert) },
                { "psx-diff-delete", ToHexColor(editorColors.diffDelete) },

                { "psx-error-background", ThemeColor(EnvironmentColors.VizSurfaceRedDarkColorKey) },
                { "psx-error-foreground", ThemeColor(EnvironmentColors.VizSurfaceRedLightColorKey) },
                { "psx-error-badge", ThemeColor(EnvironmentColors.VizSurfaceRedLightColorKey) },

                { "psx-warning-background", ThemeColor(EnvironmentColors.VizSurfaceGoldDarkColorKey) },
                { "psx-warning-foreground", ThemeColor(EnvironmentColors.VizSurfaceGoldLightColorKey) },
                { "psx-warning-badge", ThemeColor(EnvironmentColors.VizSurfaceGoldLightColorKey) },

                { "psx-input-background", ThemeColor(EnvironmentColors.ComboBoxFocusedBackgroundColorKey) },
                { "psx-input-border", ThemeColor(EnvironmentColors.ComboBoxBorderColorKey) },
                { "psx-input-foreground", ThemeColor(EnvironmentColors.ComboBoxTextColorKey) },
                { "psx-input-placeholder-foreground", ThemeColor(EnvironmentColors.ComboBoxDisabledTextColorKey) },

                { "psx-menu-foreground", ThemeColor(EnvironmentColors.ComboBoxTextColorKey) },
                { "psx-menu-highlight", ThemeColor(EnvironmentColors.ComboBoxTextColorKey) },
                { "psx-menu-hover-background", ThemeColor(isDark ? EnvironmentColors.ComboBoxMouseDownBackgroundColorKey : EnvironmentColors.ComboBoxItemMouseOverBackgroundColorKey) },
                { "psx-menu-active-foreground", ThemeColor(isDark ? EnvironmentColors.ComboBoxMouseDownTextColorKey : EnvironmentColors.ComboBoxMouseOverTextColorKey) },
                { "psx-menu-active-background", ThemeColor(isDark ? EnvironmentColors.ComboBoxMouseDownBackgroundColorKey : EnvironmentColors.ComboBoxItemMouseOverBackgroundColorKey) },
                { "psx-menu-active-highlight", ThemeColor(isDark ? EnvironmentColors.ComboBoxMouseDownTextColorKey : EnvironmentColors.ComboBoxMouseOverTextColorKey) },

                { "psx-toggle-off-background", ThemeColor(EnvironmentColors.ComboBoxDisabledBackgroundColorKey) },
                { "psx-toggle-on-background", ThemeColor(EnvironmentColors.ComboBoxSelectionColorKey) },

                { "psx-tooltip-foreground", ThemeColor(EnvironmentColors.ToolTipTextColorKey) },
                { "psx-tooltip-background", ThemeColor(EnvironmentColors.ToolTipColorKey) },
                { "psx-tooltip-border", ThemeColor(EnvironmentColors.ToolTipBorderColorKey) },

                { "vs-scroll-track", ThemeColor(EnvironmentColors.ScrollBarBackgroundColorKey) },
                { "vs-scroll-thumb", ThemeColor(EnvironmentColors.ScrollBarThumbBackgroundColorKey) },

                // Terminal colors - using editor colors since terminal is rendered in a tool window with editor background
                { "psx-terminal-font", "var(--psx-font-mono)" },
                { "psx-terminal-foreground", ToHexColor(editorColors.editorForeground) ?? ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },
                { "psx-terminal-background", ToHexColor(editorColors.editorBackground) ?? ThemeColor(EnvironmentColors.ToolWindowBackgroundColorKey) },
                { "psx-terminal-cursor", ToHexColor(editorColors.editorForeground) ?? ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },
                { "psx-terminal-cursor-accent", ToHexColor(editorColors.editorBackground) ?? ThemeColor(EnvironmentColors.ToolWindowBackgroundColorKey) },
                { "psx-terminal-selection-background", ToHexColor(editorColors.selectionBackground) ?? ThemeColor(EnvironmentColors.ComboBoxSelectionColorKey) },
                { "psx-terminal-selection-foreground", ToHexColor(editorColors.selectionForeground) ?? ThemeColor(EnvironmentColors.ToolWindowTextColorKey) },
                { "psx-terminal-selection-inactive-background", ToHexColor(editorColors.lineHighlightBorder) ?? ToHexColor(editorColors.selectionBackground) },

                // ANSI colors - VS doesn't expose these directly, so we use standard terminal colors
                { "psx-terminal-black", isDark ? "#000000" : "#000000" },
                { "psx-terminal-red", isDark ? "#CD3131" : "#CD3131" },
                { "psx-terminal-green", isDark ? "#0DBC79" : "#00BC00" },
                { "psx-terminal-yellow", isDark ? "#E5E510" : "#949800" },
                { "psx-terminal-blue", isDark ? "#2472C8" : "#0451A5" },
                { "psx-terminal-magenta", isDark ? "#BC3FBC" : "#BC05BC" },
                { "psx-terminal-cyan", isDark ? "#11A8CD" : "#0598BC" },
                { "psx-terminal-white", isDark ? "#E5E5E5" : "#555555" },
                { "psx-terminal-bright-black", isDark ? "#666666" : "#666666" },
                { "psx-terminal-bright-red", isDark ? "#F14C4C" : "#CD3131" },
                { "psx-terminal-bright-green", isDark ? "#23D18B" : "#14CE14" },
                { "psx-terminal-bright-yellow", isDark ? "#F5F543" : "#B5BA00" },
                { "psx-terminal-bright-blue", isDark ? "#3B8EEA" : "#0451A5" },
                { "psx-terminal-bright-magenta", isDark ? "#D670D6" : "#BC05BC" },
                { "psx-terminal-bright-cyan", isDark ? "#29B8DB" : "#0598BC" },
                { "psx-terminal-bright-white", isDark ? "#E5E5E5" : "#A5A5A5" },
            };
        }

        internal static bool IsDark()
        {
            return VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBackgroundColorKey).GetBrightness() < 0.5;
        }

        private static string ThemeColor(ThemeResourceKey key)
        {
            return ToHexColor(VSColorTheme.GetThemedColor(key));
        }

        private static string ToHexColor(Color color)
        {
            return color != null ? $"#{color.R:X2}{color.G:X2}{color.B:X2}" : null;
        }

        public static string GetDefaultEditorFontName()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var componentModel = ServiceProvider.GlobalProvider.GetService(typeof(SComponentModel)) as IComponentModel;
            if (componentModel == null)
                return null;
            var fontsAndColorsInformationService = componentModel.GetService<IVsFontsAndColorsInformationService>();
            if (fontsAndColorsInformationService == null)
                return null;
            var guidDefaultFileType = new Guid(2184822468u, 61063, 4560, 140, 152, 0, 192, 79, 194, 171, 34); // from Microsoft.VisualStudio.Editor.Implementation.ImplGuidList
            var info = fontsAndColorsInformationService.GetFontAndColorInformation(new Microsoft.VisualStudio.Editor.FontsAndColorsCategory(
                guidDefaultFileType,
                Microsoft.VisualStudio.Editor.DefGuidList.guidTextEditorFontCategory,
                Microsoft.VisualStudio.Editor.DefGuidList.guidTextEditorFontCategory));
            var preferences = info.GetFontAndColorPreferences();
            var logFont = new LOGFONT();
            if (GetObject(preferences.hRegularViewFont, Marshal.SizeOf(logFont), ref logFont) != 0)
                return logFont.lfFaceName;
            return null;
        }

        internal class EditorColors
        {
            public Color editorBackground;
            public Color editorForeground;
            public Color selectionBackground;
            public Color selectionForeground;
            public Color lineNumber;
            public Color lineHighlightBorder;
            public Color gutterBackground;
            public Color diffInsert;
            public Color diffDelete;
        }

        internal static EditorColors GetEditorColors(bool isDark)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var editorColors = new EditorColors();
            var fontAndColorStorage = ServiceProvider.GlobalProvider.GetService(typeof(SVsFontAndColorStorage)) as IVsFontAndColorStorage;
            if (fontAndColorStorage == null)
                return editorColors;

            var textEditorCategory = Microsoft.VisualStudio.Editor.DefGuidList.guidTextEditorFontCategory;
            var result = fontAndColorStorage.OpenCategory(ref textEditorCategory, (uint)__FCSTORAGEFLAGS.FCSF_READONLY | (uint)__FCSTORAGEFLAGS.FCSF_LOADDEFAULTS | (uint)__FCSTORAGEFLAGS.FCSF_NOAUTOCOLORS);
            if (result == VSConstants.S_OK)
            {
                try
                {
                    // In theory, the category names here follow what's in the options page. In practice, you can only get a
                    // subset of them.
                    var info = new ColorableItemInfo[1];
                    result = fontAndColorStorage.GetItem("Plain Text", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.editorBackground = ColorTranslator.FromOle((int)info[0].crBackground);
                        editorColors.editorForeground = ColorTranslator.FromOle((int)info[0].crForeground);
                    }
                    result = fontAndColorStorage.GetItem("Selected Text", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.selectionBackground = ColorTranslator.FromOle((int)info[0].crBackground);
                        editorColors.selectionForeground = ColorTranslator.FromOle((int)info[0].crForeground);
                    }
                    result = fontAndColorStorage.GetItem("Line Number", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.lineNumber = ColorTranslator.FromOle((int)info[0].crForeground);
                    }
                    result = fontAndColorStorage.GetItem("Indicator Margin", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.gutterBackground = ColorTranslator.FromOle((int)info[0].crBackground);
                    }
                    result = fontAndColorStorage.GetItem("Track additions in documents under source control", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.diffInsert = isDark
                            ? ControlPaint.Dark(ColorTranslator.FromOle((int)info[0].crBackground), 0.5f)
                            : ControlPaint.Light(ColorTranslator.FromOle((int)info[0].crBackground), 1.75f);
                    }
                    result = fontAndColorStorage.GetItem("Track deletions in documents under source control", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.diffDelete = isDark
                            ? ControlPaint.Dark(ColorTranslator.FromOle((int)info[0].crBackground), 0.5f)
                            : ControlPaint.Light(ColorTranslator.FromOle((int)info[0].crBackground), 1.75f); ;
                    }
                    result = fontAndColorStorage.GetItem("Inactive Selected Text", info);
                    if (result == VSConstants.S_OK)
                    {
                        editorColors.lineHighlightBorder = ColorTranslator.FromOle((int)info[0].crBackground);
                    }
                }
                finally
                {
                    fontAndColorStorage.CloseCategory();
                }
            }

            return editorColors;
        }

        internal static ColorTheme BuildColorTheme()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var themeName = IsDark() ? "vs-dark" : "vs";
            var tokenColors = new List<ColorThemeTokenColor>();

            var fontAndColorStorage = ServiceProvider.GlobalProvider.GetService(typeof(SVsFontAndColorStorage)) as IVsFontAndColorStorage;
            if (fontAndColorStorage != null)
            {
                var textEditorCategory = Microsoft.VisualStudio.Editor.DefGuidList.guidTextEditorFontCategory;
                var result = fontAndColorStorage.OpenCategory(ref textEditorCategory, (uint)__FCSTORAGEFLAGS.FCSF_READONLY | (uint)__FCSTORAGEFLAGS.FCSF_LOADDEFAULTS | (uint)__FCSTORAGEFLAGS.FCSF_NOAUTOCOLORS);
                if (result == VSConstants.S_OK)
                {
                    try
                    {
                        var info = new ColorableItemInfo[1];

                        // Base classifications
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Comment",
                            new[] { "comment", "comment.line", "comment.block" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Keyword",
                            new[] { "keyword", "storage.type", "storage.modifier" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "String",
                            new[] { "string", "string.quoted" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Number",
                            new[] { "constant.numeric" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Operator",
                            new[] { "operator" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Punctuation",
                            new[] { "punctuation" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Type",
                            new[] { "entity.name.type", "support.type" });
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "Preprocessor Keyword",
                            new[] { "meta.import", "keyword.import" });

                        // Roslyn-specific keyword classification
                        AddTokenColor(tokenColors, fontAndColorStorage, info, "keyword - control",
                            new[] { "keyword.control" });
                    }
                    finally
                    {
                        fontAndColorStorage.CloseCategory();
                    }
                }
            }

            return new ColorTheme { name = themeName, tokenColors = tokenColors };
        }

        private static void AddTokenColor(List<ColorThemeTokenColor> tokenColors, IVsFontAndColorStorage storage, ColorableItemInfo[] info, string itemName, string[] scopes)
        {
            var result = storage.GetItem(itemName, info);
            if (result != VSConstants.S_OK || info[0].bForegroundValid == 0)
                return;
            var foreground = ToHexColor(ColorTranslator.FromOle((int)info[0].crForeground));
            if (foreground == null)
                return;
            tokenColors.Add(new ColorThemeTokenColor
            {
                scope = scopes,
                settings = new ColorThemeTokenSettings { foreground = foreground }
            });
        }

        internal class ColorTheme
        {
            public string name { get; set; }
            public List<ColorThemeTokenColor> tokenColors { get; set; }
        }

        internal class ColorThemeTokenColor
        {
            public object scope { get; set; }
            public ColorThemeTokenSettings settings { get; set; }
        }

        internal class ColorThemeTokenSettings
        {
            public string foreground { get; set; }
            public string background { get; set; }
            public string fontStyle { get; set; }
        }

        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetObject(IntPtr hObject, int nCount, ref LOGFONT lpObject);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct LOGFONT
        {
            public int lfHeight;
            public int lfWidth;
            public int lfEscapement;
            public int lfOrientation;
            public int lfWeight;
            public byte lfItalic;
            public byte lfUnderline;
            public byte lfStrikeOut;
            public byte lfCharSet;
            public byte lfOutPrecision;
            public byte lfClipPrecision;
            public byte lfQuality;
            public byte lfPitchAndFamily;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string lfFaceName;
        }
    }
}
