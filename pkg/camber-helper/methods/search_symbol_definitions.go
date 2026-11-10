package methods

type SearchSymbolDefinitionsParams struct {
	Symbol string  `json:"symbol"`
	Type   *string `json:"type"`
}

func (p SearchSymbolDefinitionsParams) MethodName() string {
	return "camber/searchSymbolDefinitions"
}

type SearchSymbolDefinitionsOutput struct {
	Defs []SymbolDefinition `json:"defs"`
}

type SymbolDefinition struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Path        string `json:"path"`
	Async       bool   `json:"async"`
	Receiver    string `json:"receiver"`
	Signature   string `json:"signature"`
	Comment     string `json:"comment"`
	Body        string `json:"body"`
	StartLine   uint32 `json:"startLine"`
	EndLine     uint32 `json:"endLine"`
	StartCol    uint32 `json:"startCol"`
	EndCol      uint32 `json:"endCol"`
	StartOffset uint32 `json:"startOffset"`
	EndOffset   uint32 `json:"endOffset"`
	IsTest      bool   `json:"isTest"`
}
