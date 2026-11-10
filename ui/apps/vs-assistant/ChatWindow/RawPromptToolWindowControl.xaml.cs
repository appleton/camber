using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Navigation;
using System.Windows.Shapes;

namespace Camber.Assistant.ChatWindow
{
    /// <summary>
    /// Interaction logic for RawPromptToolWindowControl.xaml
    /// </summary>
    public partial class RawPromptToolWindowControl : UserControl
    {
        public RawPromptToolWindowControl()
        {
            Microsoft.VisualStudio.Shell.ThreadHelper.ThrowIfNotOnUIThread();
            InitializeComponent();

            var editorColors = WebViewTheme.GetEditorColors(WebViewTheme.IsDark());
            RawPromptTextBox.Background = editorColors.editorBackground.ToBrush();
            RawPromptTextBox.Foreground = editorColors.editorForeground.ToBrush();
            RawPromptTextBox.FontFamily = new FontFamily(WebViewTheme.GetDefaultEditorFontName() ?? "Consolas");
            RawPromptTextBox.FontSize = 14;
        }

        public void SetContent(string content)
        {
            RawPromptTextBox.Text = content;
        }
    }
}
