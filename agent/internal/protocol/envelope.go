// Package protocol mirrors shared/src/protocol/*.ts. Keep the two in sync; docs/protocol.md is the contract.
package protocol

import "encoding/json"

// Version must match PROTOCOL_VERSION in shared/src/protocol/envelope.ts.
const Version = 1

// Envelope is the single wire type. Exactly one shape is populated depending on T.
type Envelope struct {
	T string `json:"t"` // "req" | "res" | "stream" | "event"

	// req / res / stream
	ID string `json:"id,omitempty"`

	// req
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`

	// res
	OK     *bool           `json:"ok,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`

	// stream
	Seq   *int            `json:"seq,omitempty"`
	Chunk json.RawMessage `json:"chunk,omitempty"`
	Done  bool            `json:"done,omitempty"`

	// event
	Event string          `json:"event,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return e.Code + ": " + e.Message }

// Error codes shared with the server (RPC_ERROR_CODES).
const (
	ErrUnknownMethod = "unknown_method"
	ErrInvalidParams = "invalid_params"
	ErrTimeout       = "timeout"
	ErrCancelled     = "cancelled"
	ErrUnauthorized  = "unauthorized"
	ErrUnavailable   = "unavailable"
	ErrInternal      = "internal"
	ErrNotFound      = "not_found"
)

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func NewRequest(id, method string, params any) Envelope {
	return Envelope{T: "req", ID: id, Method: method, Params: mustJSON(params)}
}

func NewResult(id string, result any) Envelope {
	ok := true
	return Envelope{T: "res", ID: id, OK: &ok, Result: mustJSON(result)}
}

func NewError(id, code, message string) Envelope {
	ok := false
	return Envelope{T: "res", ID: id, OK: &ok, Error: &RPCError{Code: code, Message: message}}
}

func NewStream(id string, seq int, chunk any, done bool) Envelope {
	return Envelope{T: "stream", ID: id, Seq: &seq, Chunk: mustJSON(chunk), Done: done}
}

func NewEvent(event string, data any) Envelope {
	return Envelope{T: "event", Event: event, Data: mustJSON(data)}
}
