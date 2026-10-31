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
	var seats, devices, searchesPerMonth int
	flag.StringVar(&output, "output", "", "signed entitlement output path")
	flag.StringVar(&privateKeyPath, "private-key-file", "", "base64url Ed25519 signing key file")
	flag.StringVar(&orgUID, "org-uid", "", "existing organization UID")
	flag.IntVar(&seats, "seats", 0, "maximum authorized users")
	flag.IntVar(&devices, "devices-per-user", defaultMaxDevicesPerUser, "maximum devices per user")
	// Search stays disabled until the administrator configures a budget.
	flag.IntVar(&searchesPerMonth, "searches-per-month", 0, "maximum web searches per month for the whole organization")
	flag.Parse()
	if flag.NArg() != 0 || output == "" || privateKeyPath == "" || seats < 1 {
		fmt.Fprintln(os.Stderr, "usage: entitlement --output FILE --private-key-file FILE --seats N [--devices-per-user N] [--searches-per-month N] [--org-uid UID]")
		os.Exit(2)
	}
	var err error
	if orgUID == "" {
		orgUID, err = entitlement.NewOrgUID()
		if err != nil {
			fail(err)
		}
	}
	key, created, err := signingKey(privateKeyPath)
	if err != nil {
		fail(err)
	}
	if created {
		fmt.Fprintln(os.Stderr, "Created release signing key:", privateKeyPath)
	}

	document, publicKey, err := entitlement.Sign(entitlement.Payload{
		Version: 1, OrgUID: orgUID, MaxAuthorizedUsers: seats, MaxDevicesPerUser: devices,
		MaxSearchesPerMonth: searchesPerMonth,
	}, strings.TrimSpace(string(key)))
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(output, document, 0o600); err != nil {
		fail(err)
	}
	// The public key is a build input for this deployment's binaries.
	fmt.Println(publicKey)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
