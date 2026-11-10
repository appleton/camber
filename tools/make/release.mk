##@ Release

VS_ASSISTANT_VERSION := $(shell awk '/<Identity .+ Version="[0-9.]+"/ { gsub(/.*Version="|".*/, "", $$0); print $$0 }' ui/apps/vs-assistant/source.extension.vsixmanifest)

# Manual releases record their tag in the managed vs-assistant/v* lineage so
# the CI nightly planner sees them and continues from the released version.
# The planner requires the released commit to be on origin/main, so run this
# after the release PR is merged.
release-visual-studio: ## Release Visual Studio assistant
	@echo "Making vs-assistant release $(VS_ASSISTANT_VERSION)"
	./node_modules/.bin/turbo build --filter="./ui/apps/vs-assistant"
	@echo "In a Windows VM, in Visual Studio, make sure Release configuration is selected and run a build."
	@echo "Press enter to continue once the build is done."
	@read dummy
	@if [ ! -f "ui/apps/vs-assistant/bin/Release/net472/camber-assistant.vsix" ]; then \
		echo "Error: missing assistant VSIX build output"; \
		exit 1; \
	fi
	cp ui/apps/vs-assistant/bin/Release/net472/camber-assistant.vsix ui/apps/vs-assistant/bin/Release/camber-assistant-$(VS_ASSISTANT_VERSION).vsix
	@set -e; \
	version="$(VS_ASSISTANT_VERSION)"; \
	minor=$${version#*.}; minor=$${minor%%.*}; \
	if [ $$((minor % 2)) -eq 0 ]; then channel=stable; else channel=nightly; fi; \
	plan=$$(pnpm -s -F @camber/release-helper find-version plan vs \
		--channel "$$channel" --version "$$version" \
		--tag-prefix vs-assistant \
		--destination "$$(ui/apps/vs-assistant/scripts/extension-identity.sh)" \
		--create-lineage); \
	tag=$$(printf '%s' "$$plan" | jq -r '.tag'); \
	annotation=$$(printf '%s' "$$plan" | jq -r '.tagAnnotation'); \
	sha=$$(printf '%s' "$$plan" | jq -r '.sourceSha'); \
	git tag --annotate --message "$$annotation" "$$tag" "$$sha"; \
	git push origin "$$tag"; \
	if [ "$$channel" = stable ]; then release_flags="--latest"; else release_flags="--prerelease --latest=false"; fi; \
	gh release create "$$tag" "ui/apps/vs-assistant/bin/Release/camber-assistant-$$version.vsix" \
		$$release_flags --title "$$tag" --generate-notes
