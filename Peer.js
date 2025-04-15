// Peer.js
const config = require('./config');
const errors = require('./errors');
const logger = config.logger;

/**
 * Represents a client connection within a room, managing its state and Mediasoup objects.
 */
class Peer {
    /** Unique identifier for the peer. */
    id;
    /** ID of the room this peer belongs to. */
    roomId;
    /** ID of the server instance handling this peer's WebSocket. */
    instanceId;
    /** The WebSocket connection object. */
    _socket;
    /** The Mediasoup router associated with this peer's room. */
    _mediasoupRouter;
    /** Map of Mediasoup transports associated with this peer. <transportId, Transport> */
    _transports = new Map();
    /** Map of Mediasoup producers created by this peer. <producerId, Producer> */
    _producers = new Map();
    /** Map of Mediasoup consumers created for this peer. <consumerId, Consumer> */
    _consumers = new Map();
    /** Map of pending consume requests waiting for pipe producer creation. <producerId, { resolve, reject, timeoutId }> */
    _pendingConsumePipes = new Map();
    /** Flag indicating if the WebSocket connection is considered alive (based on pongs). */
    isAlive = true;
    /** Timestamp of the last received WebSocket pong message. */
    lastPong = Date.now();

    /**
     * Creates a Peer instance.
     * @param {string} peerId Unique Peer ID.
     * @param {string} roomId Room ID.
     * @param {string} instanceId Server instance ID.
     * @param {WebSocket} socket The WebSocket connection.
     * @param {mediasoup.types.Router} mediasoupRouter The room's router.
     */
    constructor(peerId, roomId, instanceId, socket, mediasoupRouter) {
        this.id = peerId;
        this.roomId = roomId;
        this.instanceId = instanceId;
        this._socket = socket;
        this._mediasoupRouter = mediasoupRouter;
        this.lastPong = Date.now();
        logger.info(`Peer created: ${this.id} in room ${this.roomId} on instance ${this.instanceId}`);
    }

    // --- Getters ---
    get socket() { return this._socket; }
    get router() { return this._mediasoupRouter; }
    getTransport(id) { return this._transports.get(id); }
    getProducer(id) { return this._producers.get(id); }
    getConsumer(id) { return this._consumers.get(id); }
    getAllProducers() { return Array.from(this._producers.values()); }
    getAllConsumers() { return Array.from(this._consumers.values()); }

    // --- Mediasoup Object Management ---
    /** Adds a transport and sets up listeners for its closure. */
    addTransport(transport) {
        this._transports.set(transport.id, transport);
        logger.debug(`Peer ${this.id}: Transport added ${transport.id} (${transport.appData.transportType})`);
        // Use observer 'close' for guaranteed cleanup notification
        transport.observer.once('close', () => {
            logger.debug(`Peer ${this.id}: Transport ${transport.id} observer closed.`);
            this._transports.delete(transport.id);
        });
        transport.on('dtlsstatechange', (state) => {
            if (state === 'failed') logger.warn(`Peer ${this.id}: Transport ${transport.id} DTLS failed`);
        });
    }

    /** Adds a producer and sets up listeners for its closure. */
    addProducer(producer) {
        this._producers.set(producer.id, producer);
        logger.debug(`Peer ${this.id}: Producer added ${producer.id} (kind: ${producer.kind})`);
        producer.observer.once('close', () => {
            logger.debug(`Peer ${this.id}: Producer ${producer.id} observer closed.`);
            this._producers.delete(producer.id);
        });
    }

    /** Adds a consumer and sets up listeners for relevant events. */
    addConsumer(consumer, origin) {
        this._consumers.set(consumer.id, consumer);
        logger.debug(`Peer ${this.id}: Consumer added ${consumer.id} (producerId: ${consumer.producerId}, origin: ${origin})`);

        consumer.observer.once('close', () => {
            logger.debug(`Peer ${this.id}: Consumer ${consumer.id} observer closed.`);
            this._consumers.delete(consumer.id);
        });
        consumer.on('producerclose', () => {
            logger.debug(`Peer ${this.id}: Consumer ${consumer.id}'s producer closed.`);
            this.notify('consumerClosed', { consumerId: consumer.id, reason: 'producerclose' });
            this._consumers.delete(consumer.id); // Ensure cleanup
        });
        consumer.on('producerpause', () => this.notify('consumerPaused', { consumerId: consumer.id }));
        consumer.on('producerresume', () => this.notify('consumerResumed', { consumerId: consumer.id }));
        consumer.on('layerschange', (layers) => this.notify('consumerLayersChanged', { consumerId: consumer.id, layers }));
    }

    /** Closes and removes a specific producer created by this peer. */
    removeProducer(producerId) {
        const producer = this._producers.get(producerId);
        if (producer && !producer.closed) {
            logger.debug(`Peer ${this.id}: Closing producer ${producerId}`);
            producer.close(); // Observer 'close' handles map deletion
        } else if (!producer) {
             logger.warn(`Peer ${this.id}: Attempted to remove non-existent producer ${producerId}`);
        }
    }

    /** Closes and removes a specific consumer created for this peer. */
    removeConsumer(consumerId) {
        const consumer = this._consumers.get(consumerId);
        if (consumer && !consumer.closed) {
            logger.debug(`Peer ${this.id}: Closing consumer ${consumerId}`);
            consumer.close(); // Observer 'close' handles map deletion
        } else if (!consumer) {
             logger.warn(`Peer ${this.id}: Attempted to remove non-existent consumer ${consumerId}`);
        }
    }

    // --- Pipe Request State Management ---
    /**
     * Creates a promise that waits for a pipe producer to become available.
     * Used when consuming a remote producer.
     * @param {string} producerId - The ID of the original remote producer.
     * @returns {Promise<{pipeProducerId: string}>} Resolves with the ID of the locally created pipe producer.
     */
    addPendingConsumePipe(producerId) {
        return new Promise((resolve, reject) => {
            if (this._pendingConsumePipes.has(producerId)) {
                logger.warn(`Peer ${this.id}: Consume request already pending for producer ${producerId}`);
                return reject(errors.createError(errors.INVALID_STATE, `Consume request already pending for producer ${producerId}`));
            }
            const timeoutId = setTimeout(() => {
                 logger.warn(`Peer ${this.id}: Timeout waiting for pipe producer ready for ${producerId}`);
                 this.rejectPendingConsumePipe(producerId, 'Pipe creation timed out');
            }, 30000); // 30s timeout

            this._pendingConsumePipes.set(producerId, { resolve, reject, timeoutId });
            logger.debug(`Peer ${this.id}: Added pending consume pipe request for ${producerId}`);
        });
    }

    /** Resolves a pending consume pipe request. Called when the pipe producer is ready. */
    resolvePendingConsumePipe(producerId, pipeProducerId) {
        const pending = this._pendingConsumePipes.get(producerId);
        if (pending) {
            logger.debug(`Peer ${this.id}: Resolving pending consume pipe for ${producerId} with pipeProducerId ${pipeProducerId}`);
            clearTimeout(pending.timeoutId);
            pending.resolve({ pipeProducerId });
            this._pendingConsumePipes.delete(producerId);
        } else {
             logger.warn(`Peer ${this.id}: No pending consume pipe found for producer ${producerId} to resolve.`);
        }
    }

     /** Rejects a pending consume pipe request. Called on error or timeout. */
     rejectPendingConsumePipe(producerId, reason = 'Unknown reason') {
        const pending = this._pendingConsumePipes.get(producerId);
        if (pending) {
            logger.warn(`Peer ${this.id}: Rejecting pending consume pipe for ${producerId}: ${reason}`);
            clearTimeout(pending.timeoutId);
            const error = (reason instanceof Error && reason.code)
                ? reason // Use existing structured error if available
                : errors.createError(errors.PIPING_ERROR, typeof reason === 'string' ? reason : 'Piping failed');
            pending.reject(error);
            this._pendingConsumePipes.delete(producerId);
        }
    }

    // --- Liveness Check ---
    /** Called when a WebSocket pong is received from this peer. */
    pongReceived() {
        this.lastPong = Date.now();
        this.isAlive = true;
    }

    // --- Peer Close ---
    /** Closes all associated Mediasoup objects and the WebSocket connection. */
    close(reason = 'Peer closed') {
        if (!this.isAlive && reason === 'Peer closed') { // Avoid logging closed twice if already marked dead
             reason = 'Peer unresponsive or closed';
        }
        logger.info(`Closing peer ${this.id}. Reason: ${reason}`);
        this.isAlive = false; // Mark as definitively closed

        // Close transports first - this should cascade close producers/consumers via observers
        this._transports.forEach(t => { if (!t.closed) t.close(); });
        this._transports.clear();
        this._producers.clear(); // Maps cleared after observers fire
        this._consumers.clear();

        // Reject any remaining pending requests
        this._pendingConsumePipes.forEach((req, producerId) => {
            logger.warn(`Peer ${this.id}: Rejecting pending consume pipe for ${producerId} due to peer close.`);
            this.rejectPendingConsumePipe(producerId, `Peer ${this.id} disconnected`);
        });
        this._pendingConsumePipes.clear(); // Ensure map is cleared

        // Terminate WebSocket connection
        if (this._socket.readyState === WebSocket.OPEN || this._socket.readyState === WebSocket.CONNECTING) {
            this._socket.terminate(); // Use terminate for forceful close, esp. if unresponsive
        }
        logger.info(`Peer ${this.id} closed successfully.`);
    }

    // --- JSON-RPC Methods ---
    /** Sends a JSON-RPC success response. */
    sendResponse(id, result) {
        if (this._socket.readyState !== WebSocket.OPEN || id === undefined || id === null) return;
        const message = { jsonrpc: '2.0', id: id, result: result };
        try { this._socket.send(JSON.stringify(message)); }
        catch (error) { logger.error(`Peer ${this.id}: Error sending response:`, error); }
    }

    /** Sends a JSON-RPC error response. */
    sendError(id, code, message, data) {
        if (this._socket.readyState !== WebSocket.OPEN) return;
        logger.warn(`Peer ${this.id}: Sending error response: Code ${code}, Message: ${message}`);
        const errorResponse = { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
        if (data !== undefined) errorResponse.error.data = data;
        try { this._socket.send(JSON.stringify(errorResponse)); }
        catch (error) { logger.error(`Peer ${this.id}: Error sending error response:`, error); }
    }

    /** Sends a JSON-RPC notification. */
    notify(method, params) {
        if (this._socket.readyState !== WebSocket.OPEN) return;
        const notification = { jsonrpc: '2.0', method: method, params: params };
        try { this._socket.send(JSON.stringify(notification)); }
        catch (error) { logger.error(`Peer ${this.id}: Error sending notification ${method}:`, error); }
    }
}

module.exports = Peer;