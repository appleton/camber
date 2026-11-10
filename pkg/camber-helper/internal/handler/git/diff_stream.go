package git

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

const (
	diffManifestPageSize = 100
	diffChunkMaxRows     = 400
	diffChunkMaxBytes    = 256 << 10
	diffLineMaxBytes     = 32 << 10
	diffStatsDelay       = 250 * time.Millisecond
	diffSessionTTL       = 30 * time.Minute
)

var (
	diffSessionCounter atomic.Uint64
	diffHunkHeaderRE   = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$`)
)

type diffSession struct {
	id      string
	path    string
	scope   methods.GitDiffScope
	hasHead bool
	ctx     context.Context
	cancel  context.CancelFunc
	timer   *time.Timer

	manifest *diffManifestStream

	filesMu sync.Mutex
	files   map[string]*diffFileStream
	closed  bool

	statsMu    sync.Mutex
	statsReady bool
	stats      methods.GitDiffStats
}

type diffManifestResult struct {
	file *methods.GitDiffFileSummary
	err  error
	done bool
}

type diffManifestStream struct {
	readMu  sync.Mutex
	entries []methods.GitDiffFileSummary
	next    <-chan diffManifestResult
	done    bool
	err     error
}

type diffChunkResult struct {
	chunk *methods.GitDiffChunk
	err   error
	done  bool
}

type diffChunkIndex struct {
	offset int64
	length int
	chunk  methods.GitDiffChunk
}

type diffFileStream struct {
	readMu  sync.Mutex
	next    <-chan diffChunkResult
	done    bool
	err     error
	spool   *os.File
	indices []diffChunkIndex
}

func (s *Server) DiffOpen(ctx context.Context, params *methods.GitDiffOpenParams, _ *glsp.Context) (*methods.GitDiffOpenOutput, error) {
	scope, err := normalizeDiffScope(params.Scope)
	if err != nil {
		return nil, err
	}
	inside, err := gitOutput(ctx, params.Path, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &methods.GitDiffOpenOutput{
			Unavailable: true,
			GitMissing:  errors.Is(err, errGitMissing),
			Files:       []methods.GitDiffFileSummary{},
			Complete:    true,
		}, nil
	}

	sessionCtx, cancel := context.WithCancel(context.Background())
	session := &diffSession{
		id:      fmt.Sprintf("%x-%x", time.Now().UnixNano(), diffSessionCounter.Add(1)),
		path:    params.Path,
		scope:   scope,
		ctx:     sessionCtx,
		cancel:  cancel,
		files:   make(map[string]*diffFileStream),
		hasHead: hasGitHead(ctx, params.Path),
	}

	s.diffMu.Lock()
	s.diffSessions[session.id] = session
	s.diffMu.Unlock()
	session.timer = time.AfterFunc(diffSessionTTL, func() { s.closeDiffSession(session.id) })

	files := make([]methods.GitDiffFileSummary, 0)
	nextCursor := "0"
	complete := false
	var target *methods.GitDiffFileSummary
	if params.TargetPath != "" {
		target = session.targetSummary(params.TargetPath)
	}
	session.manifest = startDiffManifest(session)
	go session.computeStats()
	return &methods.GitDiffOpenOutput{
		SessionID:  session.id,
		Files:      files,
		NextCursor: nextCursor,
		Complete:   complete,
		Target:     target,
		Stats:      session.readyStats(),
	}, nil
}

func (s *Server) DiffList(ctx context.Context, params *methods.GitDiffListParams, _ *glsp.Context) (*methods.GitDiffListOutput, error) {
	session, err := s.getDiffSession(params.SessionID)
	if err != nil {
		return nil, err
	}
	cursor, err := parseDiffCursor(params.Cursor)
	if err != nil {
		return nil, err
	}
	files, nextCursor, complete, err := session.manifest.readPage(ctx, cursor)
	if err != nil {
		return nil, err
	}
	return &methods.GitDiffListOutput{
		Files:      files,
		NextCursor: nextCursor,
		Complete:   complete,
		Stats:      session.readyStats(),
	}, nil
}

func (s *Server) DiffRead(ctx context.Context, params *methods.GitDiffReadParams, _ *glsp.Context) (*methods.GitDiffReadOutput, error) {
	session, err := s.getDiffSession(params.SessionID)
	if err != nil {
		return nil, err
	}
	if err := validateRepoFile(session.path, params.File); err != nil {
		return nil, err
	}
	cursor, err := parseDiffCursor(params.Cursor)
	if err != nil {
		return nil, err
	}
	stream, err := session.fileStream(params.File)
	if err != nil {
		return nil, err
	}
	return stream.read(ctx, cursor)
}

// DiffContents loads the full before/after contents backing one file of a
// snapshot, mapped to the snapshot's scope, so the viewer can expand collapsed
// context in place. Unavailable or oversized sides report HasContents false
// rather than an error — the collapsed-only diff still renders.
func (s *Server) DiffContents(ctx context.Context, params *methods.GitDiffContentsParams, _ *glsp.Context) (*methods.GitDiffContentsOutput, error) {
	session, err := s.getDiffSession(params.SessionID)
	if err != nil {
		return nil, err
	}
	if err := validateRepoFile(session.path, params.File); err != nil {
		return nil, err
	}
	fileParams := &methods.GitDiffFileParams{Path: session.path, File: params.File}
	switch session.scope {
	case methods.GitDiffScopeStaged:
		fileParams.Staged = true
	case methods.GitDiffScopeUncommitted:
		if isUntracked(ctx, session.path, params.File) {
			fileParams.Untracked = true
		} else {
			fileParams.Head = true
		}
	default: // unstaged: index vs worktree
		if isUntracked(ctx, session.path, params.File) {
			fileParams.Untracked = true
		}
	}
	oldContent, newContent, ok := diffFileContents(ctx, fileParams)
	if !ok {
		return &methods.GitDiffContentsOutput{}, nil
	}
	return &methods.GitDiffContentsOutput{
		HasContents: true,
		OldContent:  oldContent,
		NewContent:  newContent,
	}, nil
}

func (s *Server) DiffStats(_ context.Context, params *methods.GitDiffStatsParams, _ *glsp.Context) (*methods.GitDiffStatsOutput, error) {
	session, err := s.getDiffSession(params.SessionID)
	if err != nil {
		return nil, err
	}
	stats := session.readyStats()
	return &methods.GitDiffStatsOutput{Ready: stats != nil, Stats: stats}, nil
}

func (s *Server) DiffClose(_ context.Context, params *methods.GitDiffCloseParams, _ *glsp.Context) (*methods.GitDiffCloseOutput, error) {
	s.closeDiffSession(params.SessionID)
	return &methods.GitDiffCloseOutput{}, nil
}

func normalizeDiffScope(scope methods.GitDiffScope) (methods.GitDiffScope, error) {
	if scope == "" {
		return methods.GitDiffScopeUncommitted, nil
	}
	switch scope {
	case methods.GitDiffScopeUncommitted, methods.GitDiffScopeStaged, methods.GitDiffScopeUnstaged:
		return scope, nil
	default:
		return "", pkgerrors.Errorf("unknown diff scope %q", scope)
	}
}

func parseDiffCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(cursor)
	if err != nil || value < 0 {
		return 0, pkgerrors.Errorf("invalid diff cursor %q", cursor)
	}
	return value, nil
}

func (s *Server) getDiffSession(id string) (*diffSession, error) {
	s.diffMu.Lock()
	defer s.diffMu.Unlock()
	session := s.diffSessions[id]
	if session == nil {
		return nil, pkgerrors.Errorf("unknown or expired diff session %q", id)
	}
	session.timer.Reset(diffSessionTTL)
	return session, nil
}

func (s *Server) closeDiffSession(id string) {
	s.diffMu.Lock()
	session := s.diffSessions[id]
	delete(s.diffSessions, id)
	s.diffMu.Unlock()
	if session == nil {
		return
	}
	if session.timer != nil {
		session.timer.Stop()
	}
	session.cancel()
	session.filesMu.Lock()
	defer session.filesMu.Unlock()
	session.closed = true
	for _, stream := range session.files {
		stream.close()
	}
}

func hasGitHead(ctx context.Context, dir string) bool {
	_, _, err := runGit(ctx, dir, "rev-parse", "--verify", "HEAD")
	return err == nil
}

func startDiffManifest(session *diffSession) *diffManifestStream {
	results := make(chan diffManifestResult)
	go func() {
		defer close(results)
		emit := func(file methods.GitDiffFileSummary) error {
			select {
			case results <- diffManifestResult{file: &file}:
				return nil
			case <-session.ctx.Done():
				return session.ctx.Err()
			}
		}
		err := streamDiffManifest(session.ctx, session.path, session.scope, session.hasHead, emit)
		select {
		case results <- diffManifestResult{done: true, err: err}:
		case <-session.ctx.Done():
		}
	}()
	return &diffManifestStream{entries: make([]methods.GitDiffFileSummary, 0), next: results}
}

func (m *diffManifestStream) readPage(ctx context.Context, cursor int) ([]methods.GitDiffFileSummary, string, bool, error) {
	m.readMu.Lock()
	defer m.readMu.Unlock()
	if cursor > len(m.entries) {
		return nil, "", false, pkgerrors.Errorf("diff manifest cursor %d is ahead of loaded entries", cursor)
	}
	end := cursor + diffManifestPageSize
	for len(m.entries) < end && !m.done {
		select {
		case result, ok := <-m.next:
			if !ok {
				m.done = true
				break
			}
			if result.file != nil {
				m.entries = append(m.entries, *result.file)
			}
			if result.done {
				m.done = true
				m.err = result.err
			}
		case <-ctx.Done():
			return nil, "", false, pkgerrors.WithStack(ctx.Err())
		}
	}
	if m.err != nil {
		return nil, "", false, m.err
	}
	end = min(end, len(m.entries))
	page := append(make([]methods.GitDiffFileSummary, 0, end-cursor), m.entries[cursor:end]...)
	complete := m.done && end == len(m.entries)
	nextCursor := ""
	if !complete {
		nextCursor = strconv.Itoa(end)
	}
	return page, nextCursor, complete, nil
}

func streamDiffManifest(ctx context.Context, dir string, scope methods.GitDiffScope, hasHead bool, emit func(methods.GitDiffFileSummary) error) error {
	seen := make(map[string]struct{})
	emitUnique := func(file methods.GitDiffFileSummary) error {
		if _, ok := seen[file.Path]; ok {
			return nil
		}
		seen[file.Path] = struct{}{}
		return emit(file)
	}
	streamTracked := func(args ...string) error {
		return streamGitLines(ctx, dir, args, func(line string) error {
			file, ok := parseNameStatusLine(line)
			if !ok {
				return nil
			}
			return emitUnique(file)
		})
	}

	switch scope {
	case methods.GitDiffScopeUncommitted:
		if hasHead {
			if err := streamTracked("diff", "--relative", "--no-renames", "--name-status", "HEAD", "--", "."); err != nil {
				return err
			}
		} else {
			if err := streamTracked("diff", "--relative", "--no-renames", "--cached", "--name-status", "--", "."); err != nil {
				return err
			}
			if err := streamTracked("diff", "--relative", "--no-renames", "--name-status", "--", "."); err != nil {
				return err
			}
		}
	case methods.GitDiffScopeStaged:
		if err := streamTracked("diff", "--relative", "--no-renames", "--cached", "--name-status", "--", "."); err != nil {
			return err
		}
	case methods.GitDiffScopeUnstaged:
		if err := streamTracked("diff", "--relative", "--no-renames", "--name-status", "--", "."); err != nil {
			return err
		}
	}

	if scope == methods.GitDiffScopeStaged {
		return nil
	}
	return streamGitLines(ctx, dir, []string{"ls-files", "--others", "--exclude-standard"}, func(line string) error {
		if line == "" {
			return nil
		}
		return emitUnique(methods.GitDiffFileSummary{Path: line, Status: "untracked"})
	})
}

func parseNameStatusLine(line string) (methods.GitDiffFileSummary, bool) {
	fields := strings.Split(line, "\t")
	if len(fields) < 2 || fields[0] == "" {
		return methods.GitDiffFileSummary{}, false
	}
	code := fields[0][0]
	file := methods.GitDiffFileSummary{Status: gitChangeStatus(code)}
	if (code == 'R' || code == 'C') && len(fields) >= 3 {
		file.OrigPath = fields[1]
		file.Path = fields[2]
	} else {
		file.Path = fields[1]
	}
	return file, file.Path != ""
}

func gitChangeStatus(code byte) string {
	switch code {
	case 'M':
		return "modified"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'T':
		return "typechange"
	case 'U':
		return "unmerged"
	default:
		return "unknown"
	}
}

func streamGitLines(ctx context.Context, dir string, args []string, handle func(string) error) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		if isGitMissingError(err) {
			return errGitMissing
		}
		return pkgerrors.WithStack(err)
	}
	reader := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, _, _, readErr := readBoundedLine(reader, 1<<20)
		if line != "" {
			line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			if err := handle(line); err != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return pkgerrors.WithStack(readErr)
		}
	}
	if err := cmd.Wait(); err != nil {
		return pkgerrors.Errorf("git %s: %s", strings.Join(args, " "), stderr.String())
	}
	return nil
}

func (s *diffSession) targetSummary(path string) *methods.GitDiffFileSummary {
	args := diffNameStatusArgs(s.scope, s.hasHead, path)
	if out, err := gitOutput(s.ctx, s.path, args...); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if file, ok := parseNameStatusLine(line); ok {
				return &file
			}
		}
	}
	if s.scope != methods.GitDiffScopeStaged && isUntracked(s.ctx, s.path, path) {
		return &methods.GitDiffFileSummary{Path: path, Status: "untracked"}
	}
	return nil
}

func diffNameStatusArgs(scope methods.GitDiffScope, hasHead bool, path string) []string {
	args := []string{"diff", "--relative", "--no-renames", "--name-status"}
	switch scope {
	case methods.GitDiffScopeUncommitted:
		if hasHead {
			args = append(args, "HEAD")
		} else {
			args = append(args, "--cached")
		}
	case methods.GitDiffScopeStaged:
		args = append(args, "--cached")
	}
	return append(args, "--", path)
}

func (s *diffSession) fileStream(path string) (*diffFileStream, error) {
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	if s.closed {
		return nil, pkgerrors.Errorf("diff session %q is closed", s.id)
	}
	if stream := s.files[path]; stream != nil {
		return stream, nil
	}
	spool, err := os.CreateTemp("", "camber-diff-*.patch")
	if err != nil {
		return nil, pkgerrors.WithStack(err)
	}
	results := make(chan diffChunkResult)
	stream := &diffFileStream{next: results, spool: spool}
	s.files[path] = stream
	go produceDiffChunks(s, path, results)
	return stream, nil
}

func (f *diffFileStream) read(ctx context.Context, cursor int) (*methods.GitDiffReadOutput, error) {
	f.readMu.Lock()
	defer f.readMu.Unlock()
	if cursor < len(f.indices) {
		chunk, err := f.readSpool(cursor)
		if err != nil {
			return nil, err
		}
		return &methods.GitDiffReadOutput{Chunk: chunk, NextCursor: strconv.Itoa(cursor + 1)}, nil
	}
	if cursor > len(f.indices) {
		return nil, pkgerrors.Errorf("diff file cursor %d is ahead of the stream", cursor)
	}
	if f.done {
		if f.err != nil {
			return nil, f.err
		}
		return &methods.GitDiffReadOutput{Complete: true}, nil
	}

	select {
	case result, ok := <-f.next:
		if !ok {
			f.done = true
			return &methods.GitDiffReadOutput{Complete: true}, nil
		}
		if result.done {
			f.done = true
			f.err = result.err
			if result.err != nil {
				return nil, result.err
			}
			return &methods.GitDiffReadOutput{Complete: true}, nil
		}
		if result.chunk == nil {
			return nil, pkgerrors.Errorf("diff stream returned an empty chunk")
		}
		if err := f.writeSpool(*result.chunk); err != nil {
			return nil, err
		}
		return &methods.GitDiffReadOutput{Chunk: result.chunk, NextCursor: strconv.Itoa(cursor + 1)}, nil
	case <-ctx.Done():
		return nil, pkgerrors.WithStack(ctx.Err())
	}
}

func (f *diffFileStream) writeSpool(chunk methods.GitDiffChunk) error {
	offset, err := f.spool.Seek(0, io.SeekEnd)
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	if _, err := io.WriteString(f.spool, chunk.Patch); err != nil {
		return pkgerrors.WithStack(err)
	}
	index := diffChunkIndex{offset: offset, length: len(chunk.Patch), chunk: chunk}
	index.chunk.Patch = ""
	f.indices = append(f.indices, index)
	return nil
}

func (f *diffFileStream) readSpool(cursor int) (*methods.GitDiffChunk, error) {
	index := f.indices[cursor]
	data := make([]byte, index.length)
	if _, err := f.spool.ReadAt(data, index.offset); err != nil {
		return nil, pkgerrors.WithStack(err)
	}
	chunk := index.chunk
	chunk.Patch = string(data)
	return &chunk, nil
}

func (f *diffFileStream) close() {
	f.readMu.Lock()
	defer f.readMu.Unlock()
	if f.spool == nil {
		return
	}
	name := f.spool.Name()
	_ = f.spool.Close()
	_ = os.Remove(name)
	f.spool = nil
}

func produceDiffChunks(session *diffSession, path string, results chan<- diffChunkResult) {
	defer close(results)
	args, allowExit1 := diffFileArgs(session, path)
	cmd := exec.CommandContext(session.ctx, "git", args...)
	cmd.Dir = session.path
	cmd.Env = gitEnv()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendDiffChunkResult(session.ctx, results, diffChunkResult{done: true, err: pkgerrors.WithStack(err)})
		return
	}
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		if isGitMissingError(err) {
			err = errGitMissing
		} else {
			err = pkgerrors.WithStack(err)
		}
		sendDiffChunkResult(session.ctx, results, diffChunkResult{done: true, err: err})
		return
	}
	emit := func(chunk methods.GitDiffChunk) error {
		select {
		case results <- diffChunkResult{chunk: &chunk}:
			return nil
		case <-session.ctx.Done():
			return session.ctx.Err()
		}
	}
	parseErr := parseDiffChunks(stdout, emit)
	waitErr := cmd.Wait()
	if parseErr == nil && waitErr != nil {
		var exitErr *exec.ExitError
		if !allowExit1 || !errors.As(waitErr, &exitErr) || exitErr.ExitCode() != 1 {
			parseErr = pkgerrors.Errorf("git %s: %s", strings.Join(args, " "), stderr.String())
		}
	}
	sendDiffChunkResult(session.ctx, results, diffChunkResult{done: true, err: parseErr})
}

func sendDiffChunkResult(ctx context.Context, results chan<- diffChunkResult, result diffChunkResult) {
	select {
	case results <- result:
	case <-ctx.Done():
	}
}

func diffFileArgs(session *diffSession, path string) ([]string, bool) {
	if session.scope != methods.GitDiffScopeStaged && isUntracked(session.ctx, session.path, path) {
		return []string{"diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--", os.DevNull, path}, true
	}
	if session.scope == methods.GitDiffScopeUncommitted && !session.hasHead {
		if _, err := os.Stat(filepath.Join(session.path, filepath.FromSlash(path))); err == nil {
			return []string{"diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--", os.DevNull, path}, true
		}
	}
	args := []string{"diff", "--relative", "--no-ext-diff", "--no-color", "--no-renames", "--unified=3"}
	switch session.scope {
	case methods.GitDiffScopeUncommitted:
		args = append(args, "HEAD")
	case methods.GitDiffScopeStaged:
		args = append(args, "--cached")
	}
	return append(args, "--", path), false
}

func isUntracked(ctx context.Context, dir, path string) bool {
	_, _, err := runGit(ctx, dir, "ls-files", "--error-unmatch", "--", path)
	return err != nil
}

type parsedHunkHeader struct {
	oldStart int
	newStart int
	context  string
}

// diffSegment accumulates one outgoing chunk. A segment packs whole hunks —
// their literal @@ headers are written into body — until a size cap flushes
// it, so consecutive hunks of a file stay in one renderable patch. Only a
// segment that starts mid-hunk (the continuation after an oversized hunk was
// split) synthesizes a header for its leading fragment at flush time.
type diffSegment struct {
	// Leading-fragment state, used only when synthesizeHeader is true. The
	// counts freeze once the first literal hunk header is appended.
	synthesizeHeader bool
	leadingOpen      bool
	header           string
	oldStart         int
	newStart         int
	oldCount         int
	newCount         int

	hunks          int
	rows           int
	additions      int
	deletions      int
	truncatedLines int
	body           strings.Builder
}

func parseDiffChunks(reader io.Reader, emit func(methods.GitDiffChunk) error) error {
	buffered := bufio.NewReaderSize(reader, 64<<10)
	var fileHeader strings.Builder
	var segment *diffSegment
	var currentOld, currentNew int
	var currentContext string
	hadHunk := false
	binary := false

	flush := func() error {
		if segment == nil || segment.rows == 0 {
			segment = nil
			return nil
		}
		patch := fileHeader.String()
		if segment.synthesizeHeader {
			patch += fmt.Sprintf(
				"@@ -%d,%d +%d,%d @@%s\n",
				segment.oldStart,
				segment.oldCount,
				segment.newStart,
				segment.newCount,
				segment.header,
			)
		}
		patch += segment.body.String()
		chunk := methods.GitDiffChunk{
			Patch:          patch,
			Rows:           segment.rows,
			Additions:      segment.additions,
			Deletions:      segment.deletions,
			Hunks:          segment.hunks,
			TruncatedLines: segment.truncatedLines,
		}
		segment = nil
		return emit(chunk)
	}

	continuation := func() *diffSegment {
		return &diffSegment{
			synthesizeHeader: true,
			leadingOpen:      true,
			header:           currentContext,
			oldStart:         currentOld,
			newStart:         currentNew,
			hunks:            1,
		}
	}

	for {
		line, truncated, _, err := readBoundedLine(buffered, diffLineMaxBytes)
		if line != "" {
			if hunk, ok := parseDiffHunkHeader(strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")); ok {
				hadHunk = true
				currentOld = hunk.oldStart
				currentNew = hunk.newStart
				currentContext = hunk.context
				// Pack whole hunks into the open segment (keeping their
				// literal headers) until a cap is reached, so hunks of one
				// file render together with separators between them.
				if segment != nil && (segment.rows >= diffChunkMaxRows || fileHeader.Len()+segment.body.Len()+len(line)+128 > diffChunkMaxBytes) {
					if err := flush(); err != nil {
						return err
					}
				}
				if segment == nil {
					segment = &diffSegment{}
				}
				segment.leadingOpen = false
				segment.hunks++
				segment.body.WriteString(line)
			} else if !hadHunk {
				if fileHeader.Len()+len(line) <= diffChunkMaxBytes {
					fileHeader.WriteString(line)
				}
				binary = binary || strings.HasPrefix(line, "Binary files ") || strings.HasPrefix(line, "GIT binary patch")
			} else {
				if segment == nil {
					segment = continuation()
				}
				if segment.rows > 0 && (segment.rows >= diffChunkMaxRows || fileHeader.Len()+segment.body.Len()+len(line)+128 > diffChunkMaxBytes) {
					if err := flush(); err != nil {
						return err
					}
					segment = continuation()
				}
				addDiffSegmentLine(segment, line, truncated)
				switch line[0] {
				case ' ':
					currentOld++
					currentNew++
				case '-':
					currentOld++
				case '+':
					currentNew++
				}
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return pkgerrors.WithStack(err)
		}
	}
	if err := flush(); err != nil {
		return err
	}
	if !hadHunk && fileHeader.Len() > 0 {
		return emit(methods.GitDiffChunk{Patch: fileHeader.String(), Binary: binary})
	}
	return nil
}

func parseDiffHunkHeader(line string) (parsedHunkHeader, bool) {
	match := diffHunkHeaderRE.FindStringSubmatch(line)
	if match == nil {
		return parsedHunkHeader{}, false
	}
	oldStart, oldErr := strconv.Atoi(match[1])
	newStart, newErr := strconv.Atoi(match[3])
	if oldErr != nil || newErr != nil {
		return parsedHunkHeader{}, false
	}
	return parsedHunkHeader{oldStart: oldStart, newStart: newStart, context: match[5]}, true
}

func addDiffSegmentLine(segment *diffSegment, line string, truncated bool) {
	segment.body.WriteString(line)
	if truncated {
		segment.truncatedLines++
	}
	if line == "" || line[0] == '\\' {
		return
	}
	segment.rows++
	// The old/new counts describe only the leading synthesized fragment;
	// lines under literal hunk headers carry their own counts already.
	switch line[0] {
	case ' ':
		if segment.leadingOpen {
			segment.oldCount++
			segment.newCount++
		}
	case '-':
		segment.deletions++
		if segment.leadingOpen {
			segment.oldCount++
		}
	case '+':
		segment.additions++
		if segment.leadingOpen {
			segment.newCount++
		}
	}
}

func readBoundedLine(reader *bufio.Reader, limit int) (line string, truncated bool, originalBytes int, err error) {
	var kept []byte
	for {
		fragment, readErr := reader.ReadSlice('\n')
		originalBytes += len(fragment)
		if len(kept) < limit {
			remaining := limit - len(kept)
			kept = append(kept, fragment[:min(remaining, len(fragment))]...)
		}
		switch {
		case readErr == nil:
			err = nil
		case errors.Is(readErr, bufio.ErrBufferFull):
			continue
		case errors.Is(readErr, io.EOF):
			err = io.EOF
		default:
			return "", false, originalBytes, readErr
		}
		break
	}
	if originalBytes > limit {
		prefix := byte(' ')
		if len(kept) > 0 {
			prefix = kept[0]
		}
		return fmt.Sprintf("%c[line omitted: %d bytes]\n", prefix, originalBytes), true, originalBytes, err
	}
	return string(kept), false, originalBytes, err
}

type limitedBuffer struct {
	data bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	const limit = 32 << 10
	remaining := limit - b.data.Len()
	if remaining > 0 {
		_, _ = b.data.Write(p[:min(remaining, len(p))])
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	return strings.TrimSpace(b.data.String())
}

func (s *diffSession) computeStats() {
	select {
	case <-time.After(diffStatsDelay):
	case <-s.ctx.Done():
		return
	}
	stats := methods.GitDiffStats{}
	seen := make(map[string]struct{})
	add := func(file methods.GitDiffFileStats) {
		if file.Path == "" {
			return
		}
		if _, ok := seen[file.Path]; ok {
			return
		}
		seen[file.Path] = struct{}{}
		stats.Files++
		stats.Additions += file.Additions
		stats.Deletions += file.Deletions
		stats.FileStats = append(stats.FileStats, file)
	}
	addWorktreeFile := func(name string) error {
		path := filepath.Join(s.path, filepath.FromSlash(name))
		lines, binary, err := countTextFileLines(s.ctx, path)
		if err != nil {
			if info, statErr := os.Lstat(path); statErr == nil && !info.Mode().IsRegular() {
				add(methods.GitDiffFileStats{Path: name, Binary: true})
			}
			return nil
		}
		file := methods.GitDiffFileStats{Path: name, Binary: binary}
		if !binary {
			file.Additions = lines
		}
		add(file)
		return nil
	}

	if s.scope == methods.GitDiffScopeUncommitted && !s.hasHead {
		// With no HEAD, the combined diff is the current worktree versus an
		// empty tree. Counting current tracked and untracked files matches the
		// per-file /dev/null patches, including edits made after staging.
		_ = streamGitLines(s.ctx, s.path, []string{"ls-files", "--cached", "--others", "--exclude-standard"}, addWorktreeFile)
	} else {
		args := []string{"diff", "--relative", "--no-renames", "--numstat"}
		switch s.scope {
		case methods.GitDiffScopeUncommitted:
			args = append(args, "HEAD")
		case methods.GitDiffScopeStaged:
			args = append(args, "--cached")
		}
		args = append(args, "--", ".")
		_ = streamGitLines(s.ctx, s.path, args, func(line string) error {
			fields := strings.SplitN(line, "\t", 3)
			if len(fields) < 3 {
				return nil
			}
			file := methods.GitDiffFileStats{Path: fields[2]}
			if value, err := strconv.Atoi(fields[0]); err == nil {
				file.Additions = value
			} else {
				file.Binary = true
			}
			if value, err := strconv.Atoi(fields[1]); err == nil {
				file.Deletions = value
			} else {
				file.Binary = true
			}
			add(file)
			return nil
		})
		if s.ctx.Err() != nil {
			return
		}
		if s.scope != methods.GitDiffScopeStaged {
			_ = streamGitLines(s.ctx, s.path, []string{"ls-files", "--others", "--exclude-standard"}, addWorktreeFile)
		}
	}
	if s.ctx.Err() != nil {
		return
	}
	sort.Slice(stats.FileStats, func(i, j int) bool { return stats.FileStats[i].Path < stats.FileStats[j].Path })
	s.statsMu.Lock()
	s.stats = stats
	s.statsReady = true
	s.statsMu.Unlock()
}

func (s *diffSession) readyStats() *methods.GitDiffStats {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	if !s.statsReady {
		return nil
	}
	stats := s.stats
	return &stats
}

func countTextFileLines(ctx context.Context, path string) (lines int, binary bool, err error) {
	info, err := os.Lstat(path)
	if err != nil {
		return 0, false, pkgerrors.WithStack(err)
	}
	if !info.Mode().IsRegular() {
		return 0, false, pkgerrors.Errorf("cannot count lines in non-regular file %q", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, false, pkgerrors.WithStack(err)
	}
	defer file.Close()
	buffer := make([]byte, 64<<10)
	var last byte
	hasData := false
	for {
		select {
		case <-ctx.Done():
			return 0, false, pkgerrors.WithStack(ctx.Err())
		default:
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			hasData = true
			chunk := buffer[:n]
			if bytes.IndexByte(chunk, 0) >= 0 {
				binary = true
			}
			lines += bytes.Count(chunk, []byte{'\n'})
			last = chunk[len(chunk)-1]
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, false, pkgerrors.WithStack(readErr)
		}
	}
	if hasData && last != '\n' {
		lines++
	}
	return lines, binary, nil
}
