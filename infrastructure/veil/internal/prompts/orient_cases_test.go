package prompts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The labeled classifier fixture. It is checked in so prompt and catalog changes
// are measurable against a fixed set rather than against whatever the author
// happened to try. This test validates the fixture's shape and coverage; scoring
// a model against it requires a live endpoint and is not a unit test.
const orientCaseFixture = "../../../../packages/runner/tests/fixtures/harness/orient-cases.json"

type orientCase struct {
	ID               string `json:"id"`
	Route            string `json:"route"`
	Request          string `json:"request"`
	PreviousResponse string `json:"previousResponse"`
	Bucket           string `json:"bucket"`
	Note             string `json:"note"`
}

func loadOrientCases(t *testing.T) []orientCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(orientCaseFixture))
	if err != nil {
		t.Fatalf("read orient case fixture: %v", err)
	}
	var cases []orientCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse orient case fixture: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("orient case fixture is empty")
	}
	return cases
}

// Every labeled case must name a real route and a bucket that exists in that
// route's catalog. A bucket rename that misses the fixture fails here rather
// than silently scoring every case for that bucket as wrong.
func TestLabeledOrientCasesMatchTheRouteCatalogs(t *testing.T) {
	seen := map[string]bool{}
	for _, testCase := range loadOrientCases(t) {
		if testCase.ID == "" || seen[testCase.ID] {
			t.Fatalf("case id %q is missing or duplicated", testCase.ID)
		}
		seen[testCase.ID] = true
		route := Route(testCase.Route)
		if _, ok := RouteBuckets(route); !ok {
			t.Fatalf("case %s names unknown route %q", testCase.ID, testCase.Route)
		}
		if testCase.Request == "" {
			t.Fatalf("case %s has no request text", testCase.ID)
		}
		if !KnownBucket(route, testCase.Bucket) {
			t.Fatalf("case %s labels bucket %q, which is not in the %s catalog",
				testCase.ID, testCase.Bucket, testCase.Route)
		}
		// Context is free text, not a selector: the only thing it must not be is
		// longer than the bound the classifier will actually receive.
		if len([]rune(testCase.PreviousResponse)) > MaxOrientContextRunes {
			t.Fatalf("case %s carries %d runes of context, over the %d bound",
				testCase.ID, len([]rune(testCase.PreviousResponse)), MaxOrientContextRunes)
		}
	}
}

// MinCasesPerProfile is the classification gate's sample floor. Below it the
// measured accuracy is not meaningful, so the fixture is required to hold it.
const MinCasesPerProfile = 50

// A fixture that never exercises a bucket cannot detect a regression in it, and
// one with too few cases per profile cannot support the accuracy gate.
func TestLabeledOrientCasesCoverEveryBucketOnEveryRoute(t *testing.T) {
	labeled := map[Route]map[string]int{}
	total := map[Route]int{}
	for _, testCase := range loadOrientCases(t) {
		route := Route(testCase.Route)
		if labeled[route] == nil {
			labeled[route] = map[string]int{}
		}
		labeled[route][testCase.Bucket]++
		total[route]++
	}
	for _, route := range []Route{EngineeringChat, MarketingChat, SalesChat} {
		if total[route] < MinCasesPerProfile {
			t.Fatalf("%s has %d labeled cases, gate needs at least %d",
				route, total[route], MinCasesPerProfile)
		}
		buckets, _ := RouteBuckets(route)
		for _, bucket := range buckets {
			if labeled[route][bucket.ID] == 0 {
				t.Fatalf("%s/%s has no labeled case", route, bucket.ID)
			}
		}
	}
}

// The gates that matter most are direct_answer precision and security-only
// deep_review precision, so the fixture has to carry the adversarial cases that
// can break them: "think hard" must never route to security review.
func TestLabeledOrientCasesIncludeAdversarialAndReferentialCases(t *testing.T) {
	cases := loadOrientCases(t)
	thinkHard, referential := 0, 0
	for _, testCase := range cases {
		if strings.Contains(strings.ToLower(testCase.Request), "think hard") ||
			strings.Contains(strings.ToLower(testCase.Request), "think really hard") {
			thinkHard++
			if testCase.Bucket == "deep_review" {
				t.Fatalf("case %s routes a think-hard request to deep_review", testCase.ID)
			}
		}
		if testCase.PreviousResponse != "" {
			referential++
		}
	}
	if thinkHard < 2 {
		t.Fatalf("fixture needs think-hard cases guarding deep_review precision, found %d", thinkHard)
	}
	if referential < 3 {
		t.Fatalf("fixture needs referential follow-up cases, found %d", referential)
	}
}
