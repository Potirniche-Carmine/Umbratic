//go:build windows

package main

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// FILE_ALL_ACCESS, as used by the FA SDDL access right.
const signingKeyFileAllAccess windows.ACCESS_MASK = 0x001f01ff

func createPrivateSigningKey(path string) (*os.File, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	sid := user.User.Sid.String()
	security, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;;FA;;;" + sid + ")")
	if err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	attributes := windows.SecurityAttributes{
		Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: security,
	}
	// Set the protected ACL as the file is created. Inherited directory grants
	// must never expose even a temporarily empty private-key file.
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, &attributes, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

func validatePrivateSigningKey(file *os.File) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	security, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := security.Owner()
	if err != nil || owner == nil || !owner.Equals(user.User.Sid) {
		return errors.New("signing key must be owned by the current user")
	}
	control, _, err := security.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("signing key must not inherit directory permissions")
	}
	acl, _, err := security.DACL()
	if err != nil || acl == nil || acl.AceCount != 1 {
		return errors.New("signing key must grant access only to its owner")
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, 0, &ace); err != nil {
		return err
	}
	grantee := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask != signingKeyFileAllAccess || !grantee.Equals(user.User.Sid) {
		return errors.New("signing key must grant full access only to its owner")
	}
	return nil
}
