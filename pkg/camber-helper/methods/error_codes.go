package methods

import (
	"github.com/appleton/camber/pkg/humautil"
	"github.com/danielgtaylor/huma/v2"
)

//go:generate go-enum

// CamberErrorCode are our application specific codes (for cases not covered by
// the jsonrpc standard codes), in range 1400-1599. For ease of reading, we categorise them like http errors:
// 14xx for input errors, 15xx for internal errors, and map to existing http statuses
// if it will aid comprehension.
// ENUM(entity_not_found=1404,conflict=1409,entity_invalid=1422,user_config_invalid=1423,internal_error=1500,agent_install_failed=1502)
type CamberErrorCode int64

// ENUM(sandbox_definition)
type ErrorEntityType string

func (ErrorEntityType) Schema(r huma.Registry) *huma.Schema {
	return humautil.EnumSchema(_ErrorEntityTypeValue)
}

func (CamberErrorCode) Schema(r huma.Registry) *huma.Schema {
	return humautil.EnumSchema(_CamberErrorCodeValue)
}
