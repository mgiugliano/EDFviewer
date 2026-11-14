# Prefer rustup toolchain (Homebrew rust lacks wasm32 target); harmless if absent
export PATH := /opt/homebrew/opt/rustup/bin:$(HOME)/.cargo/bin:$(PATH)

.PHONY: all wasm dev build test

all: build

wasm:
	cd web && npm run build:wasm

dev:
	cd web && npm run dev

build: wasm
	cd web && npm run build

test:
	cd core && cargo test
