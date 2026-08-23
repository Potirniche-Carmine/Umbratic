package httpapi

import (
	"strconv"
	"testing"
	"time"
)

func TestQuotaLimiterSpendsAndRefills(t *testing.T) {
	limiter := newQuotaLimiter(3, time.Minute)
	now := time.Now()
	for attempt := range 3 {
		if allowed, _ := limiter.allow("user", now); !allowed {
			t.Fatalf("request %d was refused inside the limit", attempt)
		}
	}
	allowed, wait := limiter.allow("user", now)
	if allowed {
		t.Fatal("the fourth request was admitted over a limit of three")
	}
	if wait <= 0 {
		t.Fatal("a refusal must say how long to wait")
	}
	if allowed, _ := limiter.allow("user", now.Add(time.Minute)); !allowed {
		t.Fatal("a full window later the bucket had not refilled")
	}
}

func TestQuotaLimiterKeysAreIndependent(t *testing.T) {
	limiter := newQuotaLimiter(1, time.Minute)
	now := time.Now()
	if allowed, _ := limiter.allow("first", now); !allowed {
		t.Fatal("the first key was refused its only token")
	}
	if allowed, _ := limiter.allow("second", now); !allowed {
		t.Fatal("one key's spend consumed another key's budget")
	}
}

// A flood of unknown keys must cost the flooder its own entries rather than
// locking an established client out, which is the failure this replaced.
func TestQuotaLimiterEvictsRatherThanRefusing(t *testing.T) {
	limiter := newQuotaLimiter(5, time.Minute)
	now := time.Now()
	if allowed, _ := limiter.allow("established", now); !allowed {
		t.Fatal("the established key was refused")
	}
	for index := range maxQuotaKeys + 100 {
		if allowed, _ := limiter.allow("flood-"+strconv.Itoa(index), now.Add(time.Second)); !allowed {
			t.Fatalf("new key %d was refused admission", index)
		}
	}
	if len(limiter.buckets) > maxQuotaKeys {
		t.Fatalf("the table grew past its bound: %d", len(limiter.buckets))
	}
}

func TestQuotaLimiterDisabledWhenUnset(t *testing.T) {
	var limiter *quotaLimiter
	if newQuotaLimiter(0, time.Minute) != nil {
		t.Fatal("a zero limit must disable the limiter")
	}
	if allowed, _ := limiter.allow("user", time.Now()); !allowed {
		t.Fatal("a disabled limiter must admit everything")
	}
}
