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
	var output, privateKeyPath, feedKeyPath, orgUID string
	var seats, devices, searchesPerMonth int
	flag.StringVar(&output, "output", "", "signed entitlement output path")
	flag.StringVar(&privateKeyPath, "private-key-file", "", "base64url Ed25519 signing key file")
	flag.StringVar(&feedKeyPath, "feed-key-file", "", "base64url update-feed master key file")
	flag.StringVar(&orgUID, "org-uid", "", "existing organization UID")
	flag.IntVar(&seats, "seats", 0, "maximum authorized users")
	flag.IntVar(&devices, "devices-per-user", defaultMaxDevicesPerUser, "maximum devices per user")
	// Zero is the honest default: an organization that bought no web search.
	flag.IntVar(&searchesPerMonth, "searches-per-month", 0, "purchased web searches per month for the whole organization")
	flag.Parse()
	if flag.NArg() != 0 || output == "" || privateKeyPath == "" || feedKeyPath == "" || seats < 1 {
		fmt.Fprintln(os.Stderr, "usage: entitlement --output FILE --private-key-file FILE --feed-key-file FILE --seats N [--devices-per-user N] [--searches-per-month N] [--org-uid UID]")
		os.Exit(2)
	}
	masterKey, err := os.ReadFile(feedKeyPath)
	if err != nil {
		fail(err)
	}
	if orgUID == "" {
		orgUID, err = entitlement.NewOrgUID()
		if err != nil {
			fail(err)
		}
	}
	// Derive from the existing master before creating any release input.
	feedKey, err := entitlement.DeriveFeedKey(string(masterKey), orgUID)
	if err != nil {
		fail(err)
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
	// Two lines: the entitlement public key, then this organization's
	// update-feed key. Both are build inputs for the customer binaries.
	fmt.Println(publicKey)
	fmt.Println(feedKey)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
