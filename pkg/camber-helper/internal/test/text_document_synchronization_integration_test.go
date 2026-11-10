package test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/pkg/test/integration/fake"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler"
)

func TestTextDocumentSynchronization(t *testing.T) {
	// this test ensures the server can accept both whole-file
	// and partial updates
	// TODO validate the server's view of the file content is expected

	simplePythonScenario := `
-- main.py --
from greeter import greeting

def main():
    # one
    print(greeting())

if __name__ == "__main__":
    # two
    main()
`

	apiMock := createAPIMock(nil)
	defer apiMock.Close()

	sb, ed1 := testHarness(t, handler.New(), apiMock, fake.UnpackTxt(simplePythonScenario))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	err := ed1.Server.DidChangeConfiguration(ctx, &protocol.DidChangeConfigurationParams{
		Settings: map[string]interface{}{
			"token":  "aa-bb-fake-token",
			"apiUrl": apiMock.URL,
		},
	})
	require.NoError(t, err)

	err = ed1.OpenFile(ctx, "main.py")
	require.NoError(t, err)

	oneLoc, err := sb.Workdir.RegexpSearch("main.py", "# one")
	require.NoError(t, err)

	err = ed1.EditBuffer(ctx, "main.py", []protocol.TextEdit{
		{
			Range:   oneLoc.Range,
			NewText: "# one - updated",
		},
	})
	require.NoError(t, err)

	twoLoc, err := sb.Workdir.RegexpSearch("main.py", "# two")
	require.NoError(t, err)

	// implicitly, this forces a whole file sync
	// TODO manually send the call, to ensure this stays true
	err = ed1.EditBuffer(ctx, "main.py", []protocol.TextEdit{
		{
			Range: protocol.Range{
				Start: protocol.Position{Line: 0, Character: 0},
				End:   protocol.Position{Line: 0, Character: 0},
			},
			NewText: "# add a comment\n",
		},
		{
			Range:   twoLoc.Range,
			NewText: "# two - updated",
		},
	})
	require.NoError(t, err)
}
