package httpapi

func needsChatModel(path string) bool {
	switch path {
	case "/api/engineering/chat", "/api/sales/chat", "/api/marketing/chat", "/api/internal/context/compact", "/api/internal/orient", "/api/model/connect", "/api/model/context":
		return true
	}
	return false
}
