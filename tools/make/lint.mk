##@ Linting and formatting

lint: bazel-lint go-fmt ## All the linters

fix: bazel-fmt go-fmt-fix ## All the lint fixers

bazel-lint: ## Run Bazel linters
	$(BAZEL_RUN) //:buildifier.check

bazel-fmt: ## Run BUILD file code formatting
	$(BAZEL_RUN) //:buildifier.format

go-fmt: ## Check Go formatting (run go-fmt-fix to apply)
	@unformatted=$$(gofmt -l $$(find . -name '*.go' \
		-not -path './third_party/*' \
		-not -path './pkg/camber-helper/gopls/*' \
		-not -path './pkg/camber-helper/internal/gopls/*')); \
	if [ -n "$$unformatted" ]; then \
		echo "The following files are not gofmt'd:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

go-fmt-fix: ## Fix Go formatting
	@find . -name '*.go' \
		-not -path './third_party/*' \
		-not -path './pkg/camber-helper/gopls/*' \
		-not -path './pkg/camber-helper/internal/gopls/*' \
		| xargs gofmt -w
