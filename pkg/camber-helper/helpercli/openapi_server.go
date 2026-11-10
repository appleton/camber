package helpercli

import (
	"net/http"
	"os"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler"
)

func RunOpenAPIServer() error {
	api := handler.New().OpenAPI()
	addr := os.Getenv("HELPER_OPENAPI_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	return http.ListenAndServe(addr, api.Adapter())
}
