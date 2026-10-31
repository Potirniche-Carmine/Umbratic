package josecipher

import "testing"

func TestEmptyAndMalformedPaddingAreRejected(t *testing.T) {
	for _, data := range [][]byte{nil, {}, {0}, make([]byte, 16)} {
		if _, err := unpadBuffer(data, 16); err == nil {
			t.Fatal("invalid CBC padding was accepted")
		}
	}
	valid := padBuffer([]byte("message"), 16)
	if result, err := unpadBuffer(valid, 16); err != nil || string(result) != "message" {
		t.Fatal("valid CBC padding did not round trip")
	}
}
