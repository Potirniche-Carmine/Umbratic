package httpapi

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// maxQuotaKeys bounds the limiter table. Company identity mode keys on the
// user, so the ceiling is the licensed seat count and this is never reached;
// shared-token mode keys on the client address, where it matters.
const maxQuotaKeys = 4096

// quotaBucket is one key's token bucket. Tokens refill continuously at
// capacity/window, so a client that pauses accrues burst back rather than being
// clipped at a window boundary the way a fixed window would.
type quotaBucket struct {
	tokens float64
	seen   time.Time
}

// quotaLimiter bounds request rate per identity. It is deliberately in-process
// and resets on restart: a single Veil serves one company, and a shared counter
// store would be a dependency bought for a deployment shape Veil does not have.
type quotaLimiter struct {
	mu       sync.Mutex
	capacity float64
	window   time.Duration
	buckets  map[string]quotaBucket
}

func newQuotaLimiter(capacity int, window time.Duration) *quotaLimiter {
	if capacity <= 0 {
		return nil
	}
	return &quotaLimiter{
		capacity: float64(capacity),
		window:   window,
		buckets:  map[string]quotaBucket{},
	}
}

// allow spends one token for key and reports whether it was available, along
// with how long the caller should wait before the next one is.
func (l *quotaLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	if l == nil {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	bucket, known := l.buckets[key]
	if !known {
		l.evictLocked(now)
		bucket = quotaBucket{tokens: l.capacity, seen: now}
	} else {
		refill := now.Sub(bucket.seen).Seconds() / l.window.Seconds() * l.capacity
		bucket.tokens = min(l.capacity, bucket.tokens+refill)
		bucket.seen = now
	}
	if bucket.tokens < 1 {
		l.buckets[key] = bucket
		wait := time.Duration((1 - bucket.tokens) / l.capacity * float64(l.window))
		return false, max(wait, time.Second)
	}
	bucket.tokens--
	l.buckets[key] = bucket
	return true, 0
}

// evictLocked keeps the table bounded by dropping fully refilled buckets first
// and then the least recently seen. Admitting a new key must never fail: a
// flood of unknown keys has to cost the flooder its own entries rather than
// locking every other client out.
func (l *quotaLimiter) evictLocked(now time.Time) {
	for key, bucket := range l.buckets {
		if now.Sub(bucket.seen) >= l.window {
			delete(l.buckets, key)
		}
	}
	for len(l.buckets) >= maxQuotaKeys {
		oldestKey, oldest := "", time.Time{}
		for key, bucket := range l.buckets {
			if oldest.IsZero() || bucket.seen.Before(oldest) {
				oldestKey, oldest = key, bucket.seen
			}
		}
		delete(l.buckets, oldestKey)
	}
}

// quotaKey identifies who a limit applies to: the authenticated user in company
// identity mode, and the client address otherwise, so a shared-token deployment
// still bounds one machine rather than the whole organization.
func (s *Server) quotaKey(r *http.Request) string {
	if userKey, _ := r.Context().Value(admissionUserKey).(string); userKey != "" {
		return userKey
	}
	return s.clientAddress(r)
}

// allowQuota spends one token and writes 429 when the key is over its limit.
// The runner already treats 429 as retryable and honors Retry-After, so a
// well-behaved client backs off without any change on its side.
func (s *Server) allowQuota(w http.ResponseWriter, r *http.Request, limiter *quotaLimiter) bool {
	allowed, wait := limiter.allow(s.quotaKey(r), time.Now())
	if allowed {
		return true
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(wait.Round(time.Second)/time.Second)))
	writeCodedError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Try again shortly.")
	return false
}
