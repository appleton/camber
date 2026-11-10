using System.Collections.Generic;

namespace Camber.Assistant.ChatWindow
{
    // Mirrors OpenAcpChatOptions in ui/packages/rpc/src/host.ts. The assistant
    // sidebar calls the openAcpChat host RPC with these to reveal or create the
    // chat window for a conversation. Property names are camelCase to match the
    // JSON sent by the webview (deserialized via NewtonsoftJsonBinder).
    public class OpenAcpChatOptions
    {
        public string conversationId { get; set; }
        public string agentServer { get; set; }
        public string sessionId { get; set; }
        public string agentName { get; set; }
        public string agentIconUrl { get; set; }
        public string sessionTitle { get; set; }
        public string cwd { get; set; }
        public List<string> workingDirectories { get; set; }
    }

    // Mirrors CloseAcpChatOptions in ui/packages/rpc/src/host.ts. The sidebar calls
    // the closeAcpChat host RPC with these to close a conversation's chat window
    // (e.g. on archive/delete).
    public class CloseAcpChatOptions
    {
        public string conversationId { get; set; }
        public string agentServer { get; set; }
        public string sessionId { get; set; }
    }

    // Sent by the chat webview (updateAcpChatPanelMetadata host RPC) to keep the
    // window's agent association current. Mirrors AcpChatPanelMetadata in rpc/host.ts.
    public class AcpChatPanelMetadata
    {
        public string agentServer { get; set; }
        public string agentName { get; set; }
        public string agentIconUrl { get; set; }
        // MCP capabilities of the active agent/model (null = not known yet). The sidebar
        // needs these (via acpActiveAgentDidChange) to render its connectors UI.
        public bool? supportsMcp { get; set; }
        public bool? allowCustomMcp { get; set; }
    }

    // Injected into the acp-chat webview as CAMBER_INITIAL_ACP_CHAT_STATE so
    // AcpChatApp knows which conversation/session it renders. Mirrors
    // AcpChatPanelInitialState in the VSCode extension. camelCase keys match the
    // webview's expected shape; null fields are dropped on serialization.
    public class AcpChatInitialState
    {
        public string kind { get; set; } // "pending" | "session"
        public string conversationId { get; set; }
        public string agentServer { get; set; }
        public string sessionId { get; set; }
        public string cwd { get; set; }
        public List<string> workingDirectories { get; set; }
    }
}
