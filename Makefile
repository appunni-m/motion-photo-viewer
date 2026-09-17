# Thin contributor interface. Make orchestrates; npm owns the JavaScript graph
# and cargo owns the WebAssembly crate. The default goal is read-only.

.DEFAULT_GOAL := help
SHELL := /bin/sh

NPM ?= npm
NODE ?= node
CARGO ?= cargo
PYTHON ?= python3
HOST ?= 127.0.0.1
PORT ?= 8000
PAGES_DIR ?= _site
BROWSER_INSTALL_ARGS ?= chromium



all: verify

help:
	@printf '%s\n' \
		'Motion Photo Viewer contributor commands (GNU Make 3.81+):' \
		'  make install         Install the locked npm dependencies.' \
		'  make wasm            Build wasm/motion_photo_wasm.wasm from the Rust crate.' \
		'  make wasm-check      Rebuild and compare with the committed module.' \
		'  make test            Run the Rust and JavaScript checks (same as verify).' \
		'  make rust-lint       cargo fmt --check and clippy with warnings denied.' \
		'  make verify          Deterministic checks: cargo test + fixture suite.' \
		'  make verify-browser  Headless browser checks against the assembled site.' \
		'  make check-real      Check three real Samsung files (downloads ~17 MB).' \
		'  make fixtures        Generate real media fixtures with ffmpeg.' \
		'  make serve           Serve the app locally (PORT=8000).' \
		'  make package-pages   Assemble and validate PAGES_DIR (default _site).' \
		'  make check-pages     Validate an existing PAGES_DIR.' \
		'  make clean           Remove build output.' \
		'' \
		'Network or filesystem side effects: install, fixtures, wasm, package-pages, serve, check-real.'

install:
	$(NPM) ci

# --- WebAssembly -------------------------------------------------------------

wasm:
	$(NODE) scripts/build-wasm.mjs

wasm-check:
	$(NODE) scripts/build-wasm.mjs --check

rust-test:
	$(CARGO) test --locked

rust-lint:
	$(CARGO) fmt --check
	$(CARGO) clippy --all-targets --locked -- -D warnings

# --- verification ------------------------------------------------------------

fixtures:
	$(NODE) scripts/make-fixtures.mjs

verify: rust-lint rust-test
	$(NPM) run verify

verify-fast: verify

verify-browser:
	$(NPM) run verify:browser

check-real:
	$(NODE) scripts/check-real-samples.mjs

test: verify

# --- site --------------------------------------------------------------------

package-pages:
	$(NODE) scripts/assemble-pages.mjs "$(PAGES_DIR)"
	$(MAKE) check-pages PAGES_DIR="$(PAGES_DIR)"

check-pages:
	$(NODE) scripts/check-pages-artifact.mjs "$(PAGES_DIR)"

serve:
	$(PYTHON) -m http.server "$(PORT)" --bind "$(HOST)"

clean:
	rm -rf _site target wasm/.motion_photo_wasm.opt.wasm
