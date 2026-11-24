package handler

import (
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/control"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// controlTools hands the control service the same handlers the desktop's
// agents, connectors, skills and local-model JSON-RPC methods run, so a CLI
// change and an app change take one path (and send the same notifications).
// Agent-server mutations share h.appAgentServers, and with it its lock.
func (h *CamberHandler) controlTools() control.Tools {
	return control.Tools{
		AgentServers: control.AgentServerTools{
			List:          h.ACPNavListAgentServers,
			CheckRuntimes: h.CheckACPNavAgentRuntimes,
			Restart:       h.acpProxyHandler.RestartServer,
			Ops:           h.appAgentServers,
		},
		MCPServers:     h.mcpServersHandler,
		LocalInference: h.localInferenceHandler,
		ListSkills: func(workspacePaths []string) []control.InstalledSkill {
			if workspacePaths == nil {
				workspacePaths = h.workspaceFolderPaths()
			}
			found := installedSkills(workspacePaths)
			skills := make([]control.InstalledSkill, 0, len(found))
			for _, skill := range found {
				skills = append(skills, control.InstalledSkill{Name: skill.Name, Description: skill.Description, Location: skill.Location, DirPath: skill.DirPath})
			}
			return skills
		},
	}
}

// notifyAgentServersChanged tells every surface to re-read the agent server
// store after camber/acpNav/setAgentServers changed it, so an open desktop
// reflects changes made by another surface or by a control action.
func (h *CamberHandler) notifyAgentServersChanged() {
	if h.remoteHub == nil {
		return
	}
	params := methods.ACPNavAgentServersDidChangeParams{}
	h.remoteHub.NotifyAll(params.MethodName(), params)
}
