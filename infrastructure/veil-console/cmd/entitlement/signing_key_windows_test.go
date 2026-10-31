//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func assertPrivateSigningKey(t *testing.T, path string) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	security, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := security.Owner()
	if err != nil || owner == nil || !owner.Equals(user.User.Sid) {
		t.Fatal("key owner is not the current user")
	}
	control, _, err := security.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("key ACL inherits directory permissions")
	}
	acl, _, err := security.DACL()
	if err != nil || acl == nil || acl.AceCount != 1 {
		t.Fatal("key ACL is not an exclusive owner grant")
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, 0, &ace); err != nil {
		t.Fatal(err)
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask != 0x001f01ff {
		t.Fatal("key ACL does not grant full file access")
	}
	if !(*windows.SID)(unsafe.Pointer(&ace.SidStart)).Equals(user.User.Sid) {
		t.Fatal("key ACL grants access to another identity")
	}
}

func TestSigningKeyRejectsBroadPermissionsWithoutReplacingBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "signing.key")
	data, _, err := signingKey(path)
	if err != nil {
		t.Fatal(err)
	}
	broad, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := signingKey(path); err == nil {
		t.Fatal("Everyone access to a signing key was accepted")
	}
	if after, err := os.ReadFile(path); err != nil || string(after) != string(data) {
		t.Fatal("rejected signing key was replaced")
	}
}
