##@ Build

build: ## Build executables
	$(BAZEL_BUILD) //...

build-target: ## Build a specific target. Usage: make build-target TARGET=//cmd/camber-helper:camber-helper
	@if [ -z "$(TARGET)" ]; then \
	  echo 'usage: make build-target TARGET=//cmd/camber-helper:camber-helper'; \
	  exit 1; \
	fi
	$(BAZEL_BUILD) $(TARGET)

publish-target: ## Run a specific publish target. Usage: make publish-target TARGET=//path/to:publish
	@if [ -z "$(TARGET)" ]; then \
	  echo 'usage: make publish-target TARGET=//path/to:publish'; \
	  exit 1; \
	fi
	$(BAZEL_RUN) $(TARGET)

build-and-profile-bazel:
	$(MAKE) build BAZEL_CMD_ARGS='$(BAZEL_CMD_ARGS) --profile=/tmp/bazel-prof.gz'
	$(BAZEL) analyze-profile /tmp/bazel-prof.gz

clean: ## Clean
	$(BAZEL) clean

expunge: ## Clean everything and shutdown Bazel server
	$(BAZEL) clean --expunge
	$(BAZEL) shutdown
