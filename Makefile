.PHONY: install build typecheck unit integration smoke

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

unit:
	npm run unit

integration: build
	npm run integration

smoke: build
	npm run smoke
