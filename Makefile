PYTHON := $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)
RUST_ENV := PATH=$(CURDIR)/.tooling/cargo/bin:$(PATH) RUSTUP_HOME=$(CURDIR)/.tooling/rustup CARGO_HOME=$(CURDIR)/.tooling/cargo

.PHONY: story-validate story-build story-test story-context story-simulate story-editor rust-setup editor-setup tauri-dev tauri-build

story-validate:
	$(PYTHON) tools/story_harness.py validate

story-build:
	$(PYTHON) tools/story_harness.py build

story-test:
	$(PYTHON) -m unittest discover -s tests -v

story-context:
	$(PYTHON) tools/story_harness.py context --scene seo_a.email_request

story-simulate:
	$(PYTHON) tools/story_harness.py simulate --route seo_a --strategy first

story-editor:
	$(PYTHON) tools/story_editor.py

rust-setup:
	@if [ ! -x .tooling/cargo/bin/cargo ]; then \
		mkdir -p .tooling; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
			RUSTUP_HOME=$(CURDIR)/.tooling/rustup CARGO_HOME=$(CURDIR)/.tooling/cargo sh -s -- -y --profile minimal; \
	fi

editor-setup: rust-setup
	python3 -m venv .venv
	.venv/bin/python -m pip install -r requirements-story.txt
	npm install

tauri-dev:
	$(RUST_ENV) npm run tauri dev

tauri-build:
	$(RUST_ENV) npm run tauri -- build --bundles app
