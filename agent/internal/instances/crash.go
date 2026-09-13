package instances

import "time"

const (
	// crashBudget restarts are allowed within crashWindow before an instance stays crashed.
	crashBudget = 3
	crashWindow = 10 * time.Minute
	// crashRestartDelay is how long to wait before restarting a crashed instance.
	crashRestartDelay = 5 * time.Second
)

// crashRestartAllowed records a crash at now and reports whether a restart is within budget, the
// attempt number, and the pruned crash history.
func crashRestartAllowed(history []time.Time, now time.Time) (ok bool, attempt int, kept []time.Time) {
	for _, t := range history {
		if now.Sub(t) < crashWindow {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	attempt = len(kept)
	return attempt <= crashBudget, attempt, kept
}
