package auth

import "testing"

func TestPasswordHashAndVerify(t *testing.T) {
	encoded, err := HashPassword("a valid password with spaces")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(encoded, "a valid password with spaces") {
		t.Fatal("password did not verify")
	}
	if VerifyPassword(encoded, "a different valid password") {
		t.Fatal("wrong password verified")
	}
}

func TestPasswordLimits(t *testing.T) {
	for _, password := range []string{"too short", string(make([]byte, 129))} {
		if err := ValidatePassword(password); err == nil {
			t.Fatalf("accepted invalid password length %d", len(password))
		}
	}
}

func TestOpaqueTokenStoresHash(t *testing.T) {
	plain, hash, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if plain == string(hash) || string(HashToken(plain)) != string(hash) {
		t.Fatal("token hash mismatch")
	}
}
