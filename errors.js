// errors.js

// Standard JSON-RPC 2.0 Error Codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// -32000 to -32099: Reserved for implementation-defined server-errors.
// Custom Application Error Codes within this range
const ROOM_NOT_FOUND = -32000;
const PEER_NOT_FOUND = -32001;
const ALREADY_JOINED = -32002;
const NOT_IN_ROOM = -32003;
const TRANSPORT_NOT_FOUND = -32004;
const PRODUCER_NOT_FOUND = -32005;
const CONSUMER_NOT_FOUND = -32006;
const MEDIASOUP_ERROR = -32007;   // Generic mediasoup operation error
const INVALID_STATE = -32008;     // e.g., trying to produce on recv transport
const PERMISSION_DENIED = -32009; // For potential future authorization checks
const PEER_ID_TAKEN = -32010;     // Peer ID already exists in the room (Redis check)
const INVALID_PRODUCER_OWNER = -32011; // Mismatch during consume request
const PIPING_ERROR = -32012;      // Error related to pipeToRouter operations

/**
 * Helper function to create structured JSON-RPC 2.0 error objects.
 * @param {number} code - The JSON-RPC error code.
 * @param {string} message - A human-readable error message.
 * @param {any} [data] - Optional data associated with the error.
 * @returns {{code: number, message: string, data?: any, _stack?: string}} The error object.
 */
function createError(code, message, data) {
    const err = { code, message };
    if (data !== undefined) {
        err.data = data;
    }
    // Attach stack in non-production for easier debugging server-side
    if (process.env.NODE_ENV !== 'production') {
        // Capture stack trace excluding this function call itself
        const stackHolder = {};
        Error.captureStackTrace(stackHolder, createError);
        err._stack = stackHolder.stack;
    }
    return err;
}

module.exports = {
    // Standard codes
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    INTERNAL_ERROR,
    // Custom codes
    ROOM_NOT_FOUND,
    PEER_NOT_FOUND,
    ALREADY_JOINED,
    NOT_IN_ROOM,
    TRANSPORT_NOT_FOUND,
    PRODUCER_NOT_FOUND,
    CONSUMER_NOT_FOUND,
    MEDIASOUP_ERROR,
    INVALID_STATE,
    PERMISSION_DENIED,
    PEER_ID_TAKEN,
    INVALID_PRODUCER_OWNER,
    PIPING_ERROR,
    // Helper
    createError,
};