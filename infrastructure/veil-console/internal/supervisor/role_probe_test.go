package supervisor

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"umbratic-veil-console/internal/config"
)

func TestRoleReadinessRequiresUsableEndpoint(t *testing.T) {
	for _, tc := range []struct{ role, path, payload string }{
		{config.RoleChat, "/v1/chat/completions", `{"choices":[{"message":{"content":"ready"}}]}`},
		{config.RoleEmbedding, "/v1/embeddings", `{"data":[{"embedding":[0.1,0.2]}]}`},
		{config.RoleSpeech, "/v1/audio/transcriptions", `{"text":""}`},
	} {
		t.Run(tc.role, func(t *testing.T) {
			for _, valid := range []bool{true, false} {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodPost || r.URL.Path != tc.path {
						t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					}
					if tc.role == config.RoleSpeech {
						file, _, err := r.FormFile("file")
						if err != nil {
							t.Error(err)
						} else {
							file.Close()
						}
					}
					if valid {
						fmt.Fprint(w, tc.payload)
					} else {
						fmt.Fprint(w, `{}`)
					}
				}))
				u, _ := url.Parse(server.URL)
				port, _ := strconv.Atoi(u.Port())
				model := withPort(managedModel(), port)
				model.Role = tc.role
				err := probeModelRole(context.Background(), model)
				server.Close()
				if (err == nil) != valid {
					t.Fatalf("valid=%v, error=%v", valid, err)
				}
			}
		})
	}
}

func TestNativeRuntimeAlwaysBindsLoopback(t *testing.T) {
	for _, host := range []string{"--host 0.0.0.0", "--host=::", ""} {
		model := managedModel()
		model.Command = strings.Replace(model.Command, "--host 127.0.0.1", host, 1)
		args, err := vllmArgs(model)
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "--host 127.0.0.1") && !strings.Contains(joined, "--host=127.0.0.1") {
			t.Fatal(joined)
		}
		if strings.Contains(joined, "0.0.0.0") || strings.Contains(joined, "--host=::") {
			t.Fatal(joined)
		}
	}
}
