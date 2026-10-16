APP_NAME = MarkdownPreview
SCHEME   = MarkdownPreview
PROJECT  = MarkdownPreview.xcodeproj
DERIVED  = $(HOME)/Library/Developer/Xcode/DerivedData
LSREGISTER = /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
BUILT    = $(shell find $(DERIVED) -name "$(APP_NAME).app" -path "*/Debug/*" -print0 2>/dev/null | xargs -0 ls -dt 2>/dev/null | head -1)

.PHONY: build install open clean test js-test swift-test

# Fast inner loop for the JS editing core (red/green TDD).
js-test:
	node --test tests/*.test.mjs

# Swift unit tests (wraps xcodebuild per house rule — never call it directly).
swift-test:
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug test

# Full suite: JS core + Swift.
test: js-test swift-test

build:
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug build

# Every build registers its DerivedData copy with LaunchServices as well. With
# more than one copy registered the app's claim on Markdown files stops taking
# — silently, LSSetDefaultRoleHandler still reports success — and .md files
# open in whatever LaunchServices falls back to, so leave only the installed
# copy registered. Unregistering one LaunchServices has already forgotten is
# an error, hence the -.
install: build
	rm -rf /Applications/$(APP_NAME).app
	cp -R "$(BUILT)" /Applications/$(APP_NAME).app
	-@find $(DERIVED) -maxdepth 5 -name "$(APP_NAME).app" -print0 2>/dev/null \
		| xargs -0 -I{} $(LSREGISTER) -u "{}" >/dev/null 2>&1
	$(LSREGISTER) -f /Applications/$(APP_NAME).app
	@echo "Installed to /Applications/$(APP_NAME).app"

open: install
	open /Applications/$(APP_NAME).app

clean:
	rm -rf $(DERIVED)/$(APP_NAME)-*
