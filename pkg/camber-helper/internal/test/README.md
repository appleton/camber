# Integration tests

These tests mainly use the `fake` editor package to test places we want good
coverage of LSP usage. Generally inline unit tests in the handlers suffice,
as we can call handlers directly, and listen to sync and async (`Call` and `Notify`) output
via passing in mocked `glsp.Context`s.

You might also want to write tests here to cover your lsp/json deserialization and validation
logic.

It might make sense to inline these into the handler package, as they're not
massively different in capabilities to our normal unit tests. May require
a little package refactoring to avoid circular imports.
