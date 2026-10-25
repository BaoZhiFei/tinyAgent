.PHONY: test web-test infra-check verify

test:
	go test ./...

verify:
	@test -z "$$(gofmt -l $$(find . -name '*.go' -not -path './.superpowers/*'))"
	go vet ./...
	go test ./...
	$(MAKE) web-test
	$(MAKE) infra-check

web-test:
	cd web && npm test -- --run && npm run build

infra-check:
	cd infra && npm run build
