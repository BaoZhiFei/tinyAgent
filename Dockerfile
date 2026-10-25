# API 镜像：第一段负责编译，第二段只保留运行所需的程序和根证书；不包含源码或密钥。
FROM golang:1.24-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /out/tinyagent ./cmd/tinyagent

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/tinyagent /tinyagent
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/tinyagent"]
