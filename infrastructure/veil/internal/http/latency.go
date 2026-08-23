package httpapi

import (
	"io"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// latencySamples keeps a bounded ring of recent observations. Percentiles come
// from the ring, so memory does not grow with traffic and a long-running server
// reports recent behavior rather than its whole history.
type latencySamples struct {
	mu      sync.Mutex
	values  []float64
	next    int
	total   uint64
	filled  bool
	maxSize int
}

func newLatencySamples(size int) *latencySamples {
	return &latencySamples{values: make([]float64, size), maxSize: size}
}

func (l *latencySamples) observe(d time.Duration) {
	milliseconds := float64(d.Microseconds()) / 1000.0
	l.mu.Lock()
	defer l.mu.Unlock()
	l.values[l.next] = milliseconds
	l.next = (l.next + 1) % l.maxSize
	if l.next == 0 {
		l.filled = true
	}
	l.total++
}

// percentiles returns p50/p95/p99 in milliseconds, or zeros when nothing has
// been observed yet.
func (l *latencySamples) percentiles() (float64, float64, float64, uint64) {
	l.mu.Lock()
	count := l.maxSize
	if !l.filled {
		count = l.next
	}
	sample := make([]float64, count)
	copy(sample, l.values[:count])
	total := l.total
	l.mu.Unlock()
	if count == 0 {
		return 0, 0, 0, total
	}
	sort.Float64s(sample)
	at := func(q float64) float64 {
		index := int(q * float64(count-1))
		return sample[index]
	}
	return at(0.50), at(0.95), at(0.99), total
}

// streamMetrics is the administrator-safe view of generation behavior. It holds
// counts and durations only: no prompts, no responses, no identifiers.
type streamMetrics struct {
	timeToFirstToken *latencySamples
	streamDuration   *latencySamples
	promptTokens     atomic.Uint64
	outputTokens     atomic.Uint64
	disconnects      atomic.Uint64
	invalidStreams   atomic.Uint64
}

func newStreamMetrics() *streamMetrics {
	return &streamMetrics{
		timeToFirstToken: newLatencySamples(512),
		streamDuration:   newLatencySamples(512),
	}
}

func (m *streamMetrics) snapshot() map[string]any {
	ttftP50, ttftP95, ttftP99, ttftCount := m.timeToFirstToken.percentiles()
	durationP50, durationP95, durationP99, durationCount := m.streamDuration.percentiles()
	return map[string]any{
		"ttft_ms_p50":          ttftP50,
		"ttft_ms_p95":          ttftP95,
		"ttft_ms_p99":          ttftP99,
		"ttft_samples":         ttftCount,
		"stream_ms_p50":        durationP50,
		"stream_ms_p95":        durationP95,
		"stream_ms_p99":        durationP99,
		"stream_samples":       durationCount,
		"prompt_tokens_total":  m.promptTokens.Load(),
		"output_tokens_total":  m.outputTokens.Load(),
		"stream_disconnects":   m.disconnects.Load(),
		"invalid_stream_count": m.invalidStreams.Load(),
		"provider_retry_count": retryCount.Load(),
	}
}

// firstWriteObserver records when the first byte reaches the client, which is
// the only honest measure of time to first token from the gateway's side.
//
// It also serialises writes, because the keep-alive that runs during prefill
// shares this writer with the stream itself.
type firstWriteObserver struct {
	mu      sync.Mutex
	dst     io.Writer
	started time.Time
	onFirst func(time.Duration)
	seen    bool
}

func (o *firstWriteObserver) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.seen && len(p) > 0 {
		o.seen = true
		if o.onFirst != nil {
			o.onFirst(time.Since(o.started))
		}
	}
	return o.dst.Write(p)
}

func (o *firstWriteObserver) Flush() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.flushLocked()
}

func (o *firstWriteObserver) flushLocked() {
	if flusher, ok := o.dst.(interface{ Flush() }); ok {
		flusher.Flush()
	}
}

// writeKeepAlive emits an SSE comment, but only while nothing real has been
// written yet. Prefill on a long prompt can outlast the idle timeout of a proxy
// between here and the desktop, and a stream cut during prefill looks to the
// user exactly like a server that went away.
func (o *firstWriteObserver) writeKeepAlive() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.seen {
		return false
	}
	if _, err := o.dst.Write([]byte(":keep-alive\n\n")); err != nil {
		return false
	}
	o.flushLocked()
	return true
}
