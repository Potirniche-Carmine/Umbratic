package telemetry

import "sync/atomic"

// A bundle from a newer harness carries records this build has no reader for.
// Those are dropped rather than rejected, which means the loss is silent unless
// it is counted. These totals are what makes it visible on the metrics endpoint.
var (
	droppedTasks           atomic.Uint64
	droppedProductEvents   atomic.Uint64
	droppedFeedback        atomic.Uint64
	droppedFailedTools     atomic.Uint64
	droppedContextTriggers atomic.Uint64
	droppedEventFields     atomic.Uint64
	droppedUnknownSections atomic.Uint64
)

func noteDrops(drops Drops) {
	droppedTasks.Add(uint64(drops.Tasks))
	droppedProductEvents.Add(uint64(drops.ProductEvents))
	droppedFeedback.Add(uint64(drops.Feedback))
	droppedFailedTools.Add(uint64(drops.FailedTools))
	droppedContextTriggers.Add(uint64(drops.ContextTriggers))
	droppedEventFields.Add(uint64(drops.EventFields))
	droppedUnknownSections.Add(uint64(drops.UnknownSections))
}

// DropCounters reports the running totals for the runtime metrics endpoint.
func DropCounters() map[string]uint64 {
	return map[string]uint64{
		"telemetry_dropped_tasks":            droppedTasks.Load(),
		"telemetry_dropped_product_events":   droppedProductEvents.Load(),
		"telemetry_dropped_feedback":         droppedFeedback.Load(),
		"telemetry_dropped_failed_tools":     droppedFailedTools.Load(),
		"telemetry_dropped_context_triggers": droppedContextTriggers.Load(),
		"telemetry_dropped_event_fields":     droppedEventFields.Load(),
		"telemetry_dropped_unknown_sections": droppedUnknownSections.Load(),
	}
}
