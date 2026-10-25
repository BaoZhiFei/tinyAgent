package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/example/tinyagent/internal/session"
)

func writeStoreError(writer http.ResponseWriter, err error) {
	// 只有“session 不存在”需要告诉用户；数据库断开、查询失败等内部原因统一返回 500，
	// 详细错误由服务日志保留。
	if errors.Is(err, session.ErrSessionNotFound) {
		writeError(writer, http.StatusNotFound, "session 不存在")
		return
	}
	writeError(writer, http.StatusInternalServerError, "无法读取 session")
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	// 所有成功和失败响应都走同一编码器，保证 Content-Type 和 JSON 格式一致。
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	// 前端约定错误响应为 {"error":"..."}，不要直接把底层 error 字符串暴露出去。
	writeJSON(writer, status, map[string]string{"error": message})
}
