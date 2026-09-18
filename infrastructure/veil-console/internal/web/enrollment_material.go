package web

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
)

func (s *Server) enrollmentMaterial(code string) (string, error) {
	if !s.proxy.Available() {
		return code, nil
	}
	connection, data, err := s.proxy.Enrollment()
	if err != nil {
		return "", err
	}
	value := map[string]string{"url": connection.URL(), "code": code}
	if connection.TLS == "internal" {
		block, _ := pem.Decode(data)
		if block == nil || len(data) > 8192 {
			return "", errors.New("invalid CA")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !cert.IsCA {
			return "", errors.New("invalid CA")
		}
		value["ca"] = string(data)
	}
	data, err = json.Marshal(value)
	if err != nil {
		return "", err
	}
	return "umbr_enroll1_" + base64.RawURLEncoding.EncodeToString(data), nil
}
