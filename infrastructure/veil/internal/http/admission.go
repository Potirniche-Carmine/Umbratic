package httpapi

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// admissionController bounds concurrent model work with a global semaphore and an
// optional per-user semaphore. Waiting is capped by queueTimeout.
type admissionController struct {
	globalLimit int
	userLimit   int
	queueWait   time.Duration

	global chan struct{}

	mu    sync.Mutex
	users map[string]*userBucket

	activeRequests    atomic.Int64
	queueDepth        atomic.Int64
	overloadCount     atomic.Uint64
	cancelCount       atomic.Uint64
	timeoutCount      atomic.Uint64
	releaseErrorCount atomic.Uint64
	waitMillisSum     atomic.Uint64
	waitSamples       atomic.Uint64
}

// userBucket is reference counted so an idle bucket is dropped instead of
// accumulating one map entry per user seen over the process lifetime.
type userBucket struct {
	slots chan struct{}
	refs  int
}

func newAdmissionController(globalLimit, userLimit int, queueTimeout time.Duration) *admissionController {
	if globalLimit < 1 {
		globalLimit = 1
	}
	if userLimit < 1 {
		userLimit = 1
	}
	if userLimit > globalLimit {
		userLimit = globalLimit
	}
	if queueTimeout < time.Second {
		queueTimeout = time.Second
	}
	return &admissionController{
		globalLimit: globalLimit,
		userLimit:   userLimit,
		queueWait:   queueTimeout,
		global:      make(chan struct{}, globalLimit),
		users:       map[string]*userBucket{},
	}
}

type admissionLease struct {
	controller *admissionController
	userKey    string
	bucket     *userBucket
	started    time.Time
}

func (c *admissionController) acquire(ctx context.Context, userKey string) (*admissionLease, error) {
	waitCtx, cancel := context.WithTimeout(ctx, c.queueWait)
	defer cancel()

	c.queueDepth.Add(1)
	defer c.queueDepth.Add(-1)
	waitStarted := time.Now()

	var bucket *userBucket
	if userKey != "" {
		bucket = c.retainUserBucket(userKey)
		if err := acquireSlot(waitCtx, bucket.slots); err != nil {
			c.releaseUserBucket(userKey)
			c.recordAcquireFailure(err)
			return nil, err
		}
		if err := acquireSlot(waitCtx, c.global); err != nil {
			c.releaseSlot(bucket.slots)
			c.releaseUserBucket(userKey)
			c.recordAcquireFailure(err)
			return nil, err
		}
	} else if err := acquireSlot(waitCtx, c.global); err != nil {
		c.recordAcquireFailure(err)
		return nil, err
	}

	waited := time.Since(waitStarted)
	c.waitMillisSum.Add(uint64(waited.Milliseconds()))
	c.waitSamples.Add(1)
	c.activeRequests.Add(1)
	return &admissionLease{controller: c, userKey: userKey, bucket: bucket, started: time.Now()}, nil
}

func (l *admissionLease) release() {
	if l == nil || l.controller == nil {
		return
	}
	c := l.controller
	c.activeRequests.Add(-1)
	c.releaseSlot(c.global)
	if l.bucket != nil {
		c.releaseSlot(l.bucket.slots)
		c.releaseUserBucket(l.userKey)
	}
	l.controller = nil
}

func (c *admissionController) retainUserBucket(userKey string) *userBucket {
	c.mu.Lock()
	defer c.mu.Unlock()
	bucket, ok := c.users[userKey]
	if !ok {
		bucket = &userBucket{slots: make(chan struct{}, c.userLimit)}
		c.users[userKey] = bucket
	}
	bucket.refs++
	return bucket
}

func (c *admissionController) releaseUserBucket(userKey string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	bucket, ok := c.users[userKey]
	if !ok {
		return
	}
	bucket.refs--
	if bucket.refs <= 0 {
		delete(c.users, userKey)
	}
}

func (c *admissionController) trackedUsers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.users)
}

func acquireSlot(ctx context.Context, slots chan struct{}) error {
	select {
	case slots <- struct{}{}:
		return nil
	default:
	}
	select {
	case slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// releaseSlot returns a slot to a semaphore. Releasing a slot that was never
// held is an accounting bug, not a no-op: it is counted so it is visible in the
// operations metrics rather than silently corrupting the concurrency bound.
func (c *admissionController) releaseSlot(slots chan struct{}) {
	select {
	case <-slots:
	default:
		c.releaseErrorCount.Add(1)
	}
}

func (c *admissionController) recordAcquireFailure(err error) {
	if err == nil {
		return
	}
	if errors.Is(err, context.Canceled) {
		c.cancelCount.Add(1)
		return
	}
	c.overloadCount.Add(1)
}

func (c *admissionController) recordCancel() {
	c.cancelCount.Add(1)
}

func (c *admissionController) recordTimeout() {
	c.timeoutCount.Add(1)
}

func (c *admissionController) snapshot() opsMetrics {
	samples := c.waitSamples.Load()
	var avgWait float64
	if samples > 0 {
		avgWait = float64(c.waitMillisSum.Load()) / float64(samples)
	}
	return opsMetrics{
		ActiveRequests:    c.activeRequests.Load(),
		QueueDepth:        c.queueDepth.Load(),
		QueueWaitMsAvg:    avgWait,
		OverloadCount:     c.overloadCount.Load(),
		CancelCount:       c.cancelCount.Load(),
		TimeoutCount:      c.timeoutCount.Load(),
		ReleaseErrorCount: c.releaseErrorCount.Load(),
		TrackedUsers:      c.trackedUsers(),
		GlobalLimit:       c.globalLimit,
		PerUserLimit:      c.userLimit,
		QueueTimeoutMs:    c.queueWait.Milliseconds(),
		AdmissionEnabled:  true,
	}
}

type opsMetrics struct {
	ActiveRequests    int64   `json:"active_requests"`
	QueueDepth        int64   `json:"queue_depth"`
	QueueWaitMsAvg    float64 `json:"queue_wait_ms_avg"`
	OverloadCount     uint64  `json:"overload_count"`
	CancelCount       uint64  `json:"cancel_count"`
	TimeoutCount      uint64  `json:"timeout_count"`
	ReleaseErrorCount uint64  `json:"release_error_count"`
	TrackedUsers      int     `json:"tracked_users"`
	GlobalLimit       int     `json:"global_limit"`
	PerUserLimit      int     `json:"per_user_limit"`
	QueueTimeoutMs    int64   `json:"queue_timeout_ms"`
	AdmissionEnabled  bool    `json:"admission_enabled"`
}

func writeBusy(w http.ResponseWriter, queueTimeout time.Duration) {
	seconds := int(math.Ceil(queueTimeout.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeCodedError(w, http.StatusServiceUnavailable, "busy", "Veil is at capacity. Retry after the indicated delay.")
}
