package handler

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDiscoverSkills(t *testing.T) {
	userRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	writeSkill(t, userRoot, "uv", "uv", "User uv skill")
	writeSkill(t, userRoot, "slides", "slides", "Create presentations")
	writeSkill(t, workspaceRoot, "uv", "uv", "Workspace uv skill")
	require.NoError(t, os.MkdirAll(filepath.Join(workspaceRoot, "invalid"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(workspaceRoot, "invalid", "SKILL.md"),
		[]byte("missing frontmatter"),
		0o644,
	))

	skills := discoverSkills([]skillRoot{
		{dir: userRoot, location: "user"},
		{dir: workspaceRoot, location: "workspace"},
	})

	require.Len(t, skills, 2)
	assert.Equal(t, "slides", skills[0].Name)
	assert.Equal(t, "Create presentations", skills[0].Description)
	assert.Equal(t, "user", skills[0].Location)
	assert.Equal(t, "uv", skills[1].Name)
	assert.Equal(t, "Workspace uv skill", skills[1].Description)
	assert.Equal(t, "workspace", skills[1].Location)
	assert.Equal(t, filepath.Join(workspaceRoot, "uv"), skills[1].DirPath)
}

func TestSkillRoots(t *testing.T) {
	roots := skillRoots("/home/user", "/home/user/.config", []string{"/ws"})
	assert.Equal(t, []skillRoot{
		{dir: filepath.Join("/home/user", ".claude", "skills"), location: "user"},
		{dir: filepath.Join("/home/user/.config", "poolside", "skills"), location: "user"},
		{dir: filepath.Join("/home/user/.config", "camber", "skills"), location: "user"},
		{dir: filepath.Join("/ws", ".claude", "skills"), location: "workspace"},
		{dir: filepath.Join("/ws", ".poolside", "skills"), location: "workspace"},
		{dir: filepath.Join("/ws", ".camber", "skills"), location: "workspace"},
	}, roots)
}

func TestSkillRootsSkipsEmptyDirectories(t *testing.T) {
	roots := skillRoots("", "", []string{"/ws"})
	require.Len(t, roots, 3)
	for _, root := range roots {
		assert.Equal(t, "workspace", root.location)
	}
}

func TestCamberSkillOverridesLegacySkill(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, filepath.Join(root, ".poolside", "skills"), "review", "review", "Legacy")
	writeSkill(t, filepath.Join(root, ".camber", "skills"), "review", "review", "Camber")
	skills := discoverSkills(skillRoots("", "", []string{root}))
	require.Len(t, skills, 1)
	assert.Equal(t, "Camber", skills[0].Description)
}

func TestReadSkillFrontmatterSupportsBlockDescriptions(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "SKILL.md")
	require.NoError(t, os.WriteFile(path, []byte(`---
name: uv
description: |
  Use uv for Python environments.
  Prefer inline metadata.
---

# uv
`), 0o644))

	frontmatter, ok := readSkillFrontmatter(path)

	require.True(t, ok)
	assert.Equal(t, "uv", frontmatter.Name)
	assert.Equal(t, "Use uv for Python environments.\nPrefer inline metadata.", frontmatter.Description)
}

func TestDiscoverSkillsRejectsSymlinkedDirectories(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	writeSkill(t, target, "linked", "linked", "Outside the skill root")
	if err := os.Symlink(filepath.Join(target, "linked"), filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}

	skills := discoverSkills([]skillRoot{{dir: root, location: "workspace"}})

	assert.Empty(t, skills)
}

func TestReadSkillFrontmatterRejectsNonRegularFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "SKILL.md")
	require.NoError(t, os.Mkdir(path, 0o755))

	_, ok := readSkillFrontmatter(path)

	assert.False(t, ok)
}

func TestReadSkillFrontmatterRejectsSymlinks(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target.md")
	require.NoError(t, os.WriteFile(target, []byte("---\nname: linked\n---\n"), 0o644))
	path := filepath.Join(root, "SKILL.md")
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}

	_, ok := readSkillFrontmatter(path)

	assert.False(t, ok)
}

func TestReadSkillFrontmatterLimitsFrontmatterSize(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "SKILL.md")
	data := "---\nname: oversized\ndescription: " + strings.Repeat("x", maxSkillFrontmatterBytes) + "\n---\n"
	require.NoError(t, os.WriteFile(path, []byte(data), 0o644))

	_, ok := readSkillFrontmatter(path)

	assert.False(t, ok)
}

func TestReadSkillFrontmatterDoesNotLimitSkillBody(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "SKILL.md")
	data := "---\nname: large-body\ndescription: Valid metadata\n---\n" + strings.Repeat("x", maxSkillFrontmatterBytes)
	require.NoError(t, os.WriteFile(path, []byte(data), 0o644))

	frontmatter, ok := readSkillFrontmatter(path)

	require.True(t, ok)
	assert.Equal(t, "large-body", frontmatter.Name)
}

func writeSkill(t *testing.T, root, directory, name, description string) {
	t.Helper()
	dir := filepath.Join(root, directory)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(dir, "SKILL.md"),
		[]byte("---\nname: "+name+"\ndescription: "+description+"\n---\n"),
		0o644,
	))
}
