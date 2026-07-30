package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"umbratic-veil-console/internal/entitlement"
)

const defaultMaxDevicesPerUser = 2

func main() {
	var output, privateKeyPath, orgUID string
	var seats, devices int
	flag.StringVar(&output, "output", "", "signed entitlement output path")
	flag.StringVar(&privateKeyPath, "private-key-file", "", "base64url Ed25519 signing key file")
	flag.StringVar(&orgUID, "org-uid", "", "existing organization UID")
	flag.IntVar(&seats, "seats", 0, "maximum authorized users")
	flag.IntVar(&devices, "devices-per-user", defaultMaxDevicesPerUser, "maximum devices per user")
	flag.Parse()
	if flag.NArg() != 0 || output == "" || privateKeyPath == "" || seats < 1 {
		fmt.Fprintln(os.Stderr, "usage: entitlement --output FILE --private-key-file FILE --seats N [--devices-per-user N] [--org-uid UID]")
		os.Exit(2)
	}
	key, err := os.ReadFile(privateKeyPath)
	if err != nil {
		fail(err)
	}
	if orgUID == "" {
		orgUID, err = entitlement.NewOrgUID()
		if err != nil {
			fail(err)
		}
	}
	document, publicKey, err := entitlement.Sign(entitlement.Payload{
		Version: 1, OrgUID: orgUID, MaxAuthorizedUsers: seats, MaxDevicesPerUser: devices,
	}, strings.TrimSpace(string(key)))
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(output, document, 0o600); err != nil {
		fail(err)
	}
	fmt.Println(publicKey)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
