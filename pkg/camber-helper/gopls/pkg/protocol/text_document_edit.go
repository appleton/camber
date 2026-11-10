package protocol

func NewTextDocumentEdit(uri DocumentURI, textedits []TextEdit) *TextDocumentEdit {
	return &TextDocumentEdit{
		TextDocument: OptionalVersionedTextDocumentIdentifier{
			TextDocumentIdentifier: TextDocumentIdentifier{URI: uri},
		},
		Edits: AsAnnotatedTextEdits(textedits),
	}
}
