using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Newtonsoft.Json.Linq;
using Camber.Assistant.HelperLSP;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Camber.Assistant.ChatWindow
{
    // One MDI (document-area) window per ACP conversation, hosting the acp-chat
    // webview. The assistant sidebar opens these via the openAcpChat host RPC.
    //
    // VS gives no way to pass constructor arguments to a tool window, so (like
    // TasksToolWindow) the parameters for the next window are staged in statics
    // and read by the constructor. Transient=true keeps VS from persisting and
    // recreating these windows behind our back, so the staged state is always
    // valid when the constructor runs.
    [Guid(AcpChatToolWindowId)]
    public class AcpChatToolWindow : ToolWindowPane
    {
        internal const string AcpChatToolWindowId = "93a39099-2f2e-4f18-988e-9f93930f49dc";

        private static AcpChatInitialState initialForNewToolWindow;
        private static string titleForNewToolWindow;

        // Open chat windows keyed by conversationId, for reveal/dedup and for
        // routing ACP frames to the right window off the UI thread.
        private static readonly ConcurrentDictionary<string, AcpChatToolWindow> windows =
            new ConcurrentDictionary<string, AcpChatToolWindow>();

        // The window whose webview last reported focus, or null when none does. Focus is
        // a single value rather than a flag per window: each chat webview has its own RPC
        // server, so notifications race, and only one reference write can decide the winner
        // without leaving two windows focused or (having cleared each other) none.
        private static AcpChatToolWindow focusedWindow;

        internal string ConversationId { get; private set; }
        internal string AgentServer { get; set; }
        internal string SessionId { get; set; }

        // MCP capabilities the chat's active agent/model reported (null = unknown);
        // forwarded to the sidebar via acpActiveAgentDidChange.
        internal bool? SupportsMcp { get; set; }
        internal bool? AllowCustomMcp { get; set; }

        // The window's RPC bridge, captured on construction (UI thread) so inbound
        // ACP frames can be posted to it from the LSP dispatch threads without a
        // UI-thread hop, mirroring the TasksToolWindow communicator cache.
        internal AcpChatWebViewCommunicator Communicator { get; private set; }

        // Tick count of the last open/reveal, used to pick the most-recent window
        // when routing a request that carries no sessionId.
        internal long LastTouched { get; private set; }

        public AcpChatToolWindow() : base(null)
        {
            this.Caption = string.IsNullOrEmpty(titleForNewToolWindow) ? "Camber" : titleForNewToolWindow;
            this.ConversationId = initialForNewToolWindow.conversationId;
            this.AgentServer = initialForNewToolWindow.agentServer;
            this.SessionId = initialForNewToolWindow.sessionId;
            this.LastTouched = DateTime.UtcNow.Ticks;
            var control = new AcpChatWindowControl(initialForNewToolWindow);
            this.Content = control;
            this.Communicator = control.Communicator as AcpChatWebViewCommunicator;
            windows.AddOrUpdate(this.ConversationId, this, (_, __) => this);
            // Bring this freshly-opened window up to date with host state pushed before
            // it existed (CallWebView awaits the webview's ready, so this is safe here).
            ReplayStateToSelf();
        }

        // Host state the chat windows need (active-file context, editor focus, sandbox,
        // agent). These were historically pushed to the single sidebar webview; in the
        // split model each chat window is its own webview and needs them too. The latest
        // value per method is cached so a window opened later can be replayed into sync.
        private static readonly ConcurrentDictionary<string, object[]> replayState =
            new ConcurrentDictionary<string, object[]>();

        internal static void Broadcast(string method, params object[] args)
        {
            replayState[method] = args;
            foreach (var window in windows.Values)
            {
                _ = window.Communicator?.CallWebView(method, args);
            }
        }

        private void ReplayStateToSelf()
        {
            foreach (var kv in replayState)
            {
                _ = this.Communicator?.CallWebView(kv.Key, kv.Value);
            }
        }

        // Reveal an existing chat window for the conversation, or create a new one.
        // When neither conversationId nor a known sessionId is given, a fresh
        // "pending" window (empty agent-picker) is created.
        internal static async Task OpenSessionAsync(OpenAcpChatOptions opts)
        {
            opts = opts ?? new OpenAcpChatOptions();
            var package = CamberAssistantPackage.GetInstance();
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();

            var conversationId = opts.conversationId;
            if (string.IsNullOrEmpty(conversationId) && !string.IsNullOrEmpty(opts.sessionId))
            {
                conversationId = FindConversationForSession(opts.agentServer, opts.sessionId);
            }
            if (string.IsNullOrEmpty(conversationId))
            {
                conversationId = Guid.NewGuid().ToString();
            }

            // Updating an already-open window: refresh its routing metadata; the
            // ShowToolWindowAsync call below reveals it without re-running the ctor.
            if (windows.TryGetValue(conversationId, out var existing))
            {
                existing.AgentServer = opts.agentServer ?? existing.AgentServer;
                existing.SessionId = opts.sessionId ?? existing.SessionId;
                existing.LastTouched = DateTime.UtcNow.Ticks;
            }

            initialForNewToolWindow = new AcpChatInitialState
            {
                kind = string.IsNullOrEmpty(opts.sessionId) ? "pending" : "session",
                conversationId = conversationId,
                agentServer = opts.agentServer,
                sessionId = opts.sessionId,
                cwd = opts.cwd,
                workingDirectories = opts.workingDirectories,
            };
            titleForNewToolWindow = opts.sessionTitle ?? opts.agentName ?? "Camber";

            // create: true reveals the existing window for this id or creates one.
            await package.ShowToolWindowAsync(typeof(AcpChatToolWindow),
                Math.Abs(conversationId.GetHashCode()), true, package.DisposalToken);

            // The opened/revealed window is now the active one.
            BroadcastActiveAgent();
        }

        // Close the chat window for a conversation (the sidebar's closeAcpChat host RPC,
        // e.g. when a conversation is archived/deleted). Closing the frame fires OnClose,
        // which removes the window from the registry and disposes the webview. No-op when
        // no window is open for it.
        internal static async Task CloseSessionAsync(CloseAcpChatOptions opts)
        {
            if (opts == null) return;
            var conversationId = opts.conversationId;
            if (string.IsNullOrEmpty(conversationId) && !string.IsNullOrEmpty(opts.sessionId))
            {
                conversationId = FindConversationForSession(opts.agentServer, opts.sessionId);
            }
            if (string.IsNullOrEmpty(conversationId) || !windows.TryGetValue(conversationId, out var window))
            {
                return;
            }

            var package = CamberAssistantPackage.GetInstance();
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (window.Frame is IVsWindowFrame frame)
            {
                frame.CloseFrame((uint)__FRAMECLOSE.FRAMECLOSE_NoSave);
            }
        }

        public const string DefaultAgentServer = "poolside";

        // Associate the helper-assigned sessionId with the window for a conversation
        // (called after a successful camber/acp/session/new), so inbound ACP frames
        // can be routed back to it by (agentServer, sessionId).
        internal static void AttachSession(string conversationId, string agentServer, string sessionId)
        {
            if (string.IsNullOrEmpty(conversationId)) return;
            if (windows.TryGetValue(conversationId, out var window))
            {
                window.AgentServer = string.IsNullOrEmpty(agentServer) ? DefaultAgentServer : agentServer;
                window.SessionId = sessionId;
                // The conversation now has an open window — mark its view active.
                SetConversationViewState(window, true);
            }
        }

        // Keep the window's agent association current as the chat picks/sets its agent
        // (called from the updateAcpChatPanelMetadata host RPC), so frame routing by
        // agentServer stays correct for a pending conversation before its session exists.
        internal static void UpdateMetadata(string conversationId, AcpChatPanelMetadata metadata)
        {
            if (string.IsNullOrEmpty(conversationId) || metadata == null) return;
            if (windows.TryGetValue(conversationId, out var window))
            {
                if (!string.IsNullOrEmpty(metadata.agentServer))
                {
                    window.AgentServer = metadata.agentServer;
                }
                window.SupportsMcp = metadata.supportsMcp;
                window.AllowCustomMcp = metadata.allowCustomMcp;
                // The window reporting metadata is the one the user is interacting with.
                window.LastTouched = DateTime.UtcNow.Ticks;
                BroadcastActiveAgent();
            }
        }

        // Track which chat window the user is actually in (the setWebviewFocus host RPC).
        // Focus is the truest "active window" signal available, so gaining it also refreshes
        // LastTouched, which routing and BroadcastActiveAgent use as their proxy for active.
        internal static void SetWebViewFocus(string conversationId, bool focused)
        {
            if (string.IsNullOrEmpty(conversationId)) return;
            if (!windows.TryGetValue(conversationId, out var window)) return;
            if (!focused)
            {
                // Only clear if this window still claims focus. The window being left blurs
                // after the one being entered has focused, so an unconditional clear would
                // drop the new window's claim and leave nothing focused.
                Interlocked.CompareExchange(ref focusedWindow, null, window);
                return;
            }
            // Last focus notification wins outright, whatever order overlapping ones land in.
            Interlocked.Exchange(ref focusedWindow, window);
            window.LastTouched = DateTime.UtcNow.Ticks;
            BroadcastActiveAgent();
        }

        // True when any chat window's webview has focus, so a globally-bound keybinding can
        // tell it was pressed inside the assistant rather than while editing code.
        internal static bool AnyWebViewHasFocus()
        {
            return FocusedWindow() != null;
        }

        // Post the plan-mode toggle to the chat window the user is in. The plan-mode banner
        // lives in the chat webview, so the sidebar (which has no session of its own) is the
        // wrong target - mirrors vscode's acpChatPanels.togglePlanModeOnActivePanel. Returns
        // false when no chat window is open, so the caller can fall back to the sidebar.
        internal static bool TogglePlanModeOnActiveWindow()
        {
            var window = FocusedWindow()
                ?? windows.Values.OrderByDescending(w => w.LastTouched).FirstOrDefault();
            if (window == null) return false;
            _ = window.Communicator?.CallWebView("togglePlanMode", new object[0]);
            return true;
        }

        // Tell the sidebar (a separate webview with no session of its own) which ACP
        // agent is active and its MCP capabilities, so its connectors UI is correct.
        // Mirrors vscode's broadcastActiveAgent: the most-recently-touched chat window
        // is the active one; null agentServer when no chat window is open.
        internal static void BroadcastActiveAgent()
        {
            var window = windows.Values.OrderByDescending(w => w.LastTouched).FirstOrDefault();
            if (window == null)
            {
                ChatWindowRPCClient.acpActiveAgentDidChange(new { agentServer = (string)null });
                return;
            }
            ChatWindowRPCClient.acpActiveAgentDidChange(new
            {
                agentServer = string.IsNullOrEmpty(window.AgentServer) ? DefaultAgentServer : window.AgentServer,
                supportsMcp = window.SupportsMcp,
                allowCustomMcp = window.AllowCustomMcp,
            });
        }

        // Update each open chat window's tab caption from the latest nav state, matching
        // the window to its conversation by id (mirrors vscode applyPanelNavState's title
        // sync). Nav owns the conversation titles, so this keeps tabs labelled correctly.
        internal static async Task ApplyNavStateAsync(object navParams)
        {
            if (windows.IsEmpty) return;
            var state = AsObject(navParams)?["state"] as JObject;
            var conversations = state?["conversations"] as JArray;
            if (conversations == null) return;
            var titles = new Dictionary<string, string>();
            foreach (var c in conversations)
            {
                var id = (c as JObject)?["id"]?.Value<string>();
                var title = (c as JObject)?["title"]?.Value<string>();
                if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(title))
                {
                    titles[id] = title;
                }
            }
            if (titles.Count == 0) return;

            await CamberAssistantPackage.GetInstance().JoinableTaskFactory.SwitchToMainThreadAsync();
            foreach (var kv in titles)
            {
                if (windows.TryGetValue(kv.Key, out var window))
                {
                    window.Caption = kv.Value;
                }
            }
        }

        // Tell the helper which conversation's view is active (its window is open) so it
        // can track unread/active state (camber/acpNav/setConversationViewState).
        private static void SetConversationViewState(AcpChatToolWindow window, bool active)
        {
            if (window == null || string.IsNullOrEmpty(window.SessionId)) return;
            var agentServer = string.IsNullOrEmpty(window.AgentServer) ? DefaultAgentServer : window.AgentServer;
            _ = HelperLSPService.Instance.SendRequest("camber/acpNav/setConversationViewState",
                new { agentServer, sessionId = window.SessionId, active });
        }

        // ACP frames and session params carry agentServer/sessionId at the top level.
        internal static string AgentServerOf(object frame)
        {
            var agentServer = AsObject(frame)?["agentServer"]?.Value<string>();
            return string.IsNullOrEmpty(agentServer) ? DefaultAgentServer : agentServer;
        }

        internal static string SessionIdOf(object frame)
        {
            var obj = AsObject(frame);
            return obj?["sessionId"]?.Value<string>() ?? obj?["session_id"]?.Value<string>();
        }

        private static JObject AsObject(object value)
        {
            if (value == null) return null;
            return value as JObject ?? (JToken.FromObject(value) as JObject);
        }

        // Inbound ACP frame routing. Notifications go to the session's window (or all
        // windows of the agent when the frame carries no sessionId); requests go to the
        // session's window or, lacking one, the most-recently-touched window of the
        // agent. Returns false / null when no chat window matches, so the caller can
        // fall back to the sidebar webview.
        internal static bool RouteNotify(object frame)
        {
            var targets = NotifyTargets(AgentServerOf(frame), SessionIdOf(frame));
            if (targets.Count == 0) return false;
            foreach (var window in targets)
            {
                _ = window.Communicator?.CallWebView("jsonrpcNotify", new object[] { frame });
            }
            return true;
        }

        internal static AcpChatToolWindow RequestTarget(object frame)
        {
            var agentServer = AgentServerOf(frame);
            var sessionId = SessionIdOf(frame);
            if (!string.IsNullOrEmpty(sessionId))
            {
                // Session-scoped request: deliver ONLY to the window that owns this session.
                // If none is open, return null (caller falls back to the sidebar) rather than
                // guessing — answering from another window would corrupt a different conversation.
                return windows.Values.FirstOrDefault(
                    w => w.SessionId == sessionId && AgentMatches(w, agentServer));
            }
            // Agent-level request (no session): the most-recently-touched window of that agent.
            return AgentWindows(agentServer).OrderByDescending(w => w.LastTouched).FirstOrDefault();
        }

        internal static bool RouteServerDidExit(object frame)
        {
            // An agent exit/restart must clear the connection pool in EVERY chat window,
            // not just the exited agent's (#103) — vscode's routeAgentServerDidExit posts
            // to all panels.
            if (windows.IsEmpty) return false;
            foreach (var window in windows.Values)
            {
                _ = window.Communicator?.CallWebView("acpAgentServerDidExit", new object[] { frame });
            }
            return true;
        }

        private static List<AcpChatToolWindow> NotifyTargets(string agentServer, string sessionId)
        {
            if (!string.IsNullOrEmpty(sessionId))
            {
                return windows.Values
                    .Where(w => w.SessionId == sessionId && AgentMatches(w, agentServer))
                    .ToList();
            }
            return AgentWindows(agentServer);
        }

        // The window whose webview reports focus, or null when none does or that window has
        // since closed (OnClose clears it, but a read can race the close).
        private static AcpChatToolWindow FocusedWindow()
        {
            var window = Volatile.Read(ref focusedWindow);
            if (window == null) return null;
            return windows.TryGetValue(window.ConversationId, out var open) && ReferenceEquals(open, window)
                ? window
                : null;
        }

        private static List<AcpChatToolWindow> AgentWindows(string agentServer)
        {
            return windows.Values.Where(w => AgentMatches(w, agentServer)).ToList();
        }

        private static bool AgentMatches(AcpChatToolWindow window, string agentServer)
        {
            var windowServer = string.IsNullOrEmpty(window.AgentServer) ? DefaultAgentServer : window.AgentServer;
            return windowServer == agentServer;
        }

        private static string FindConversationForSession(string agentServer, string sessionId)
        {
            foreach (var kv in windows)
            {
                if (kv.Value.SessionId == sessionId &&
                    (agentServer == null || kv.Value.AgentServer == agentServer))
                {
                    return kv.Key;
                }
            }
            return null;
        }

        protected override void OnClose()
        {
            // Its view is no longer active (must read SessionId before removing it).
            SetConversationViewState(this, false);
            if (this.ConversationId != null)
            {
                windows.TryRemove(this.ConversationId, out _);
            }
            Interlocked.CompareExchange(ref focusedWindow, null, this);
            (this.Content as AcpChatWindowControl)?.Dispose();
            // Active agent changed (this window is gone) — refresh the sidebar.
            BroadcastActiveAgent();
        }
    }
}
