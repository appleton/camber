package control

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// skills.list is the composer's skill listing: camber/listSkills's discovery
// (InstalledSkillsRepository), and with agentServer the skill commands that
// agent publishes, merged as resolvedSkillCommands does (a published entry
// wins a name collision).
func init() {
	registerAction("skills.list", RegisteredAction{
		Summary: "List installed skills and where each comes from (user or workspace directory, or published by an agent).",
		InputSchema: objectSchema(map[string]any{
			"workspacePath": map[string]any{"type": "string", "description": "Registered project or worktree whose skill directories to scan instead of the desktop's workspace folders"},
			"agentServer":   map[string]any{"type": "string", "description": "Also include skill commands this agent published (from its cached configuration)"},
		}),
		Run: func(ctx context.Context, s *Service, raw json.RawMessage, _ string, g *glsp.Context) (any, error) {
			var a skillsListArgs
			if err := decodeActionArgs(raw, &a); err != nil {
				return nil, err
			}
			return s.listSkills(ctx, a, g)
		},
	})
}

type skillsListArgs struct {
	WorkspacePath string `json:"workspacePath,omitempty"`
	AgentServer   string `json:"agentServer,omitempty"`
}

// listedSkill is one skills.list row. Source is "user" or "workspace" for a
// discovered skill directory, or "agent" for a command the agent publishes.
type listedSkill struct {
	Name        string `json:"name"`
	Invocation  string `json:"invocation"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"`
	DirPath     string `json:"dirPath,omitempty"`
	AgentServer string `json:"agentServer,omitempty"`
}

func (s *Service) listSkills(ctx context.Context, a skillsListArgs, g *glsp.Context) (any, error) {
	list := s.currentTools().ListSkills
	if list == nil {
		return nil, unavailableTool("skill discovery")
	}
	var workspaces []string
	if a.WorkspacePath != "" {
		path, err := cleanControlPath("workspacePath", a.WorkspacePath)
		if err != nil {
			return nil, err
		}
		if err = s.checkRegisteredWorkspace(ctx, path, g); err != nil {
			return nil, err
		}
		workspaces = []string{path}
	}
	byName := map[string]listedSkill{}
	for _, skill := range list(workspaces) {
		byName[normalizedSkillName(skill.Name)] = listedSkill{Name: skill.Name, Invocation: skillInvocation(skill.Name), Description: skill.Description, Source: skill.Location, DirPath: skill.DirPath}
	}
	if a.AgentServer != "" {
		agentServer := normalizeAgentServerID(a.AgentServer)
		cache, err := s.nav.GetConfigCache(ctx, &methods.ACPNavGetConfigCacheParams{AgentServer: agentServer}, g)
		if err != nil {
			return nil, err
		}
		if cache.Entry != nil {
			var commands []struct {
				Name        string         `json:"name"`
				Description string         `json:"description"`
				Meta        map[string]any `json:"_meta"`
			}
			_ = json.Unmarshal(cache.Entry.AvailableCommands, &commands)
			for _, command := range commands {
				if !strings.HasPrefix(command.Name, "$") && command.Meta["camber/slash_command_category"] != "skill" {
					continue
				}
				byName[normalizedSkillName(command.Name)] = listedSkill{Name: strings.TrimPrefix(command.Name, "$"), Invocation: skillInvocation(command.Name), Description: command.Description, Source: "agent", AgentServer: agentServer}
			}
		}
	}
	skills := make([]listedSkill, 0, len(byName))
	for _, skill := range byName {
		skills = append(skills, skill)
	}
	sort.Slice(skills, func(i, j int) bool {
		return strings.ToLower(skills[i].Name) < strings.ToLower(skills[j].Name)
	})
	return map[string]any{"skills": skills}, nil
}

func normalizedSkillName(name string) string {
	return strings.ToLower(strings.TrimPrefix(name, "$"))
}

// skillInvocation is how a prompt invokes the skill ($name).
func skillInvocation(name string) string {
	if strings.HasPrefix(name, "$") {
		return name
	}
	return "$" + name
}
