// Room.js
const mediasoup = require('mediasoup');
const config = require('./config');
const Peer = require('./Peer');
const errors = require('./errors');

const logger = config.logger;

/**
 * Manages Mediasoup router, peers, producers, consumers, and piping for a single room
 * on a specific server instance. Interacts with RedisManager for distributed state.
 */
class Room {
    /** Room identifier. */
    id;
    /** Mediasoup router instance for this room. */
    _mediasoupRouter;
    /** Mediasoup worker running the router. */
    _worker;
    /** Map of peers connected to this room on this instance. <peerId, Peer> */
    _peers = new Map();
    /** Map of PipeTransports sending media TO remote instances. <remoteInstanceId, PipeTransport> */
    _outgoingPipeTransports = new Map();
    /** Map of PipeTransports receiving media FROM remote instances. <pipeTransportId, PipeTransport> */
    _incomingPipeTransports = new Map();
    /** Reference to the RedisManager instance. */
    _redisManager;
    /** Unique ID of the server instance managing this Room object. */
    _instanceId;
    /** Promise that resolves when the router is initialized. */
    _routerReadyPromise;

    /**
     * Creates a Room instance.
     * @param {string} roomId Room ID.
     * @param {mediasoup.types.Worker} worker Mediasoup Worker.
     * @param {RedisManager} redisManager RedisManager instance.
     * @param {string} instanceId Server instance ID.
     */
    constructor(roomId, worker, redisManager, instanceId) {
        this.id = roomId;
        this._worker = worker;
        this._redisManager = redisManager;
        this._instanceId = instanceId;
        this._routerReadyPromise = this._initializeRouter();
    }

    /** Initializes the Mediasoup router for the room. */
    async _initializeRouter() {
       try {
            const router = await this._worker.createRouter({
                ...config.mediasoup.routerOptions,
                appData: { roomId: this.id, workerPid: this._worker.pid, instanceId: this._instanceId }
            });
            this._mediasoupRouter = router;
            logger.info(`Room ${this.id}: Router created on worker ${this._worker.pid}, instance ${this._instanceId}`);
            this._mediasoupRouter.observer.once('close', () => {
                 logger.warn(`Room ${this.id}: Router ${this._mediasoupRouter.id} closed`);
                 this._mediasoupRouter = null;
                 this._closeAllPipeTransports(); // Clean up pipes if router closes
            });
            return router;
       } catch (error) {
            logger.error(`Room ${this.id}: Failed to create router:`, error);
            throw errors.createError(errors.MEDIASOUP_ERROR, `Router creation failed: ${error.message}`);
       }
    }

    // --- Getters ---
    get router() { return this._mediasoupRouter; }
    isRouterReady() { return !!this._mediasoupRouter && !this._mediasoupRouter.closed; }
    async ensureRouterReady() {
        if (this.isRouterReady()) return this._mediasoupRouter;
        return this._routerReadyPromise;
    }
    getPeer(peerId) { return this._peers.get(peerId); }
    hasPeer(peerId) { return this._peers.has(peerId); }

    // --- Peer Management ---
    /** Adds a peer to the local map and sets up socket listeners. */
    async addPeer(peer) {
        await this.ensureRouterReady();
        if (this._peers.has(peer.id)) { // Handle rejoin attempt
             logger.warn(`Room ${this.id}: Peer ${peer.id} trying to rejoin, closing old connection.`);
             const existingPeer = this._peers.get(peer.id);
             if (existingPeer && existingPeer.socket !== peer.socket) {
                 existingPeer.close('Replaced by new connection'); // Close old peer/socket
             } else {
                  throw errors.createError(errors.ALREADY_JOINED, "Peer already joined with this connection");
             }
             // Old peer removal will be handled by its 'close' event triggering removePeer()
        }
        this._peers.set(peer.id, peer);
        logger.info(`Room ${this.id}: Peer ${peer.id} added locally.`);

        // Redis state (SADD) and PubSub ('peerJoined') handled in server.js/handleJoinRoom

        peer.socket.on('close', () => this.removePeer(peer.id));
        peer.socket.on('error', (error) => {
             logger.error(`Room ${this.id}: Peer ${peer.id} socket error:`, error);
             this.removePeer(peer.id); // Treat socket error as disconnect
        });
    }

    /** Removes peer locally, closing its producers/consumers. */
    async removePeerLocally(peerId) {
        const peer = this._peers.get(peerId);
        if (!peer) return;
        logger.info(`Room ${this.id}: Removing peer ${peer.id} locally.`);

        // Close local producers first (this also triggers Redis HDEL via closeProducer)
        const producerClosePromises = peer.getAllProducers().map(p => this.closeProducer(peer.id, p.id));
        await Promise.allSettled(producerClosePromises);

        peer.close(`Removing peer ${peerId} from room ${this.id}`); // Close peer resources
        this._peers.delete(peerId);
    }

    /** Handles peer removal triggered by socket close or explicit leave. */
    async removePeer(peerId) {
        if (!this._peers.has(peerId)) return; // Already removed
        logger.info(`Room ${this.id}: Processing removal for peer ${peerId}.`);
        await this.removePeerLocally(peerId);
        // Redis state (SREM) and PubSub ('peerClosed') handled in server.js/handleLeaveRoom
    }

    // --- Producer Management ---
    /** Creates a producer, adds it locally, updates Redis, and notifies peers. */
    async createProducer(peerId, transportId, kind, rtpParameters, appData) {
        await this.ensureRouterReady();
        const peer = this.getPeer(peerId);
        if (!peer) throw errors.createError(errors.PEER_NOT_FOUND, `Peer ${peerId} not found`);
        const transport = peer.getTransport(transportId);
        if (!transport || transport.closed || transport.appData.transportType !== 'send') {
            throw errors.createError(errors.INVALID_STATE, `Send transport ${transportId} invalid or closed`);
        }

        try {
            const producer = await transport.produce({
                kind, rtpParameters,
                appData: { ...appData, peerId: peerId, transportId: transportId, instanceId: this._instanceId }
            });
            peer.addProducer(producer); // Add locally

            const producerInfo = {
                 roomId: this.id, peerId: peerId, producerId: producer.id,
                 kind: producer.kind, type: producer.type, appData: producer.appData,
                 instanceId: this._instanceId,
            };

            await this._redisManager.addProducerToRoom(this.id, producer.id, producerInfo);
            await this._redisManager.publish(this.id, 'newProducer', producerInfo);
            this.notifyLocalPeers('newProducer', producerInfo, peerId);

            return { id: producer.id };
        } catch (error) {
            logger.error(`Room ${this.id}: Failed to create producer for peer ${peerId}:`, error);
            throw errors.createError(errors.MEDIASOUP_ERROR, `Producer creation failed: ${error.message}`);
        }
    }

    /** Closes a local producer, updates Redis, and notifies peers. */
    async closeProducer(peerId, producerId) {
        const peer = this.getPeer(peerId);
        if (!peer) return; // Not a local peer's producer

        const producer = peer.getProducer(producerId);
        if (!producer) return; // Producer doesn't exist or already closed

        logger.info(`Room ${this.id}: Closing producer ${producerId} for peer ${peerId}`);
        try {
            if (!producer.closed) {
                 peer.removeProducer(producerId); // Calls producer.close()
            }
            // Update Redis Hash & Publish event (even if already closed locally, ensure Redis/PubSub consistency)
            await this._redisManager.removeProducerFromRoom(this.id, producerId);
            const eventData = { roomId: this.id, peerId: peerId, producerId: producerId, instanceId: this._instanceId };
            await this._redisManager.publish(this.id, 'producerClosed', eventData);
            this.notifyLocalPeers('producerClosed', eventData, peerId);
        } catch (error) {
             logger.error(`Room ${this.id}: Error during producer ${producerId} close process:`, error);
             // Don't throw here, cleanup should continue
        }
    }

    // --- Consumer Management & Piping ---
    /** Creates a consumer for a peer, handling local vs remote producers (piping). */
    async createConsumer(peerId, targetPeerId, producerId, rtpCapabilities, transportId) {
        await this.ensureRouterReady();
        const consumingPeer = this.getPeer(peerId);
        if (!consumingPeer) throw errors.createError(errors.PEER_NOT_FOUND, `Consuming peer ${peerId} not found`);
        const recvTransport = consumingPeer.getTransport(transportId);
        if (!recvTransport || recvTransport.closed || recvTransport.appData.transportType !== 'recv') {
            throw errors.createError(errors.INVALID_STATE, `Receive transport ${transportId} invalid or closed`);
        }

        // 1. Check local first
        const localProducer = this.getPeer(targetPeerId)?.getProducer(producerId);
        if (localProducer && !localProducer.closed) {
            logger.debug(`Room ${this.id}: Consuming local producer ${producerId}`);
            return this._createConsumerInternal(consumingPeer, localProducer, rtpCapabilities, recvTransport, 'local');
        }

        // 2. Get remote producer info from Redis
        const remoteProducerInfo = await this._redisManager.getProducerInfo(this.id, producerId);
        if (!remoteProducerInfo) throw errors.createError(errors.PRODUCER_NOT_FOUND, `Producer ${producerId} not found`);
        if (remoteProducerInfo.peerId !== targetPeerId) throw errors.createError(errors.INVALID_PRODUCER_OWNER, `Producer ${producerId} owner mismatch`);

        // 3. Initiate Pipe
        logger.info(`Room ${this.id}: Request by ${peerId} to consume remote producer ${producerId} from instance ${remoteProducerInfo.instanceId}`);
        try {
            const pipeProducer = await this._initiatePipe(consumingPeer, producerId, remoteProducerInfo.instanceId);
            logger.info(`Room ${this.id}: Pipe ready, consuming local pipe producer ${pipeProducer.id} for remote producer ${producerId}`);
            return this._createConsumerInternal(consumingPeer, pipeProducer, rtpCapabilities, recvTransport, 'pipe');
        } catch (error) {
            logger.error(`Room ${this.id}: Pipe initiation or consumption failed for producer ${producerId}:`, error);
            consumingPeer.rejectPendingConsumePipe(producerId, error.message || 'Piping failed');
            throw (error.code && error.message) ? error : errors.createError(errors.PIPING_ERROR, `Failed to consume remote producer ${producerId}: ${error.message}`);
        }
    }

    /** Helper to create the mediasoup consumer object and add it to the peer. */
    async _createConsumerInternal(peer, producer, rtpCapabilities, transport, origin) {
        if (!this.isRouterReady()) throw errors.createError(errors.MEDIASOUP_ERROR, 'Router not ready');
        if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
            throw errors.createError(errors.MEDIASOUP_ERROR, `Peer ${peer.id} cannot consume producer ${producer.id}`);
        }

        try {
            const consumer = await transport.consume({
                producerId: producer.id, rtpCapabilities,
                paused: producer.kind === 'video',
                appData: { peerId: peer.id, producerId: producer.id, transportId: transport.id, origin, ...(producer.appData.origin === 'pipe' ? { originalProducerId: producer.appData.originalProducerId } : {}) }
            });
            peer.addConsumer(consumer, origin);

            logger.info(`Peer ${peer.id}: Created consumer ${consumer.id} for producer ${producer.id} (origin: ${origin})`);
            return {
                id: consumer.id, producerId: consumer.producerId, kind: consumer.kind,
                rtpParameters: consumer.rtpParameters, paused: consumer.producerPaused,
                appData: consumer.appData,
            };
        } catch (error) {
             logger.error(`Room ${this.id}: Failed to create consumer for producer ${producer.id}, peer ${peer.id}:`, error);
             throw errors.createError(errors.MEDIASOUP_ERROR, `Consumer creation failed: ${error.message}`);
        }
    }

    /** Resumes a specific consumer for a peer. */
    async resumeConsumer(peerId, consumerId) {
        const peer = this.getPeer(peerId);
        if (!peer) throw errors.createError(errors.PEER_NOT_FOUND, `Peer ${peerId} not found`);
        const consumer = peer.getConsumer(consumerId);
        if (!consumer) throw errors.createError(errors.CONSUMER_NOT_FOUND, `Consumer ${consumerId} not found`);
        if (consumer.closed) throw errors.createError(errors.INVALID_STATE, `Consumer ${consumerId} is closed`);

        try {
            await consumer.resume();
            logger.debug(`Peer ${peerId}: Resumed consumer ${consumerId}`);
            return { resumed: true };
        } catch (error) {
            logger.error(`Room ${this.id}: Failed to resume consumer ${consumerId} for peer ${peerId}:`, error);
            throw errors.createError(errors.MEDIASOUP_ERROR, `Consumer resume failed: ${error.message}`);
        }
    }

    // --- Piping Handshake Logic ---

    /** Initiates pipe request FROM this instance TO the producing instance. */
    async _initiatePipe(consumingPeer, producerId, remoteInstanceId) {
         await this.ensureRouterReady();
         const pipeRequestId = `${producerId}_${this._instanceId}`; // Unique request ID

         // Create promise waiting for pipe producer ID
         const consumePipePromise = consumingPeer.addPendingConsumePipe(producerId);

         // Publish request to remote instance
         await this._redisManager.publish(this.id, 'requestPipeTransport', {
             roomId: this.id, pipeRequestId: pipeRequestId,
             requestingInstanceId: this._instanceId,
             producingInstanceId: remoteInstanceId,
             producerId: producerId,
         });

         // Wait for handshake completion (pipeProducerReady event resolves the promise)
         const { pipeProducerId } = await consumePipePromise;

         // Find the locally created pipe producer object
         const pipeProducer = this.router?.producers?.get(pipeProducerId); // Use optional chaining
         if (!pipeProducer || pipeProducer.closed) {
              throw errors.createError(errors.PIPING_ERROR, `Pipe producer ${pipeProducerId} not found or closed after ready signal`);
         }
         return pipeProducer;
    }

    /** Handles 'requestPipeTransport' event: Creates listening transport, responds with details. */
    async _handlePipeTransportRequest(pipeRequestId, requestingInstanceId, producerId) {
        logger.info(`Room ${this.id}: Handling pipe transport request ${pipeRequestId} for producer ${producerId} from instance ${requestingInstanceId}`);
        await this.ensureRouterReady();
        if (!this.isRouterReady()) {
            // Cannot proceed without router, notify requester
             logger.warn(`Room ${this.id}: Router not ready, cannot fulfill pipe request ${pipeRequestId}`);
             await this._redisManager.publish(this.id, 'pipeCreationFailed', {
                 roomId: this.id, pipeRequestId, requestingInstanceId, producerId,
                 reason: 'Producing instance router not ready'
             });
            return;
        }

        let transportInfo = null;
        let errorReason = null;
        let pipeTransport = null;

        try {
            // Find the original local producer
            const producer = Array.from(this._peers.values())
                                .flatMap(p => p.getAllProducers())
                                .find(p => p.id === producerId);
            if (!producer || producer.closed) throw new Error(`Producer ${producerId} not found/closed locally`);

            // Create the pipe transport on this (producing) instance
            pipeTransport = await this.router.createPipeTransport({
                 listenInfo: {
                     ...config.mediasoup.pipeTransportOptions.listenInfo,
                     announcedIp: config.mediasoup.webRtcTransportOptions.listenInfos[0].announcedIp
                 },
                 enableSctp : false,
                 appData: { pipeRequestId, type: 'pipe-listen', targetInstanceId: requestingInstanceId }
             });

            this._incomingPipeTransports.set(pipeTransport.id, pipeTransport); // Track incoming pipes
            pipeTransport.observer.once('close', () => {
                 logger.warn(`Room ${this.id}: Incoming pipe transport ${pipeTransport.id} from ${requestingInstanceId} closed.`);
                 this._incomingPipeTransports.delete(pipeTransport.id);
            });

            // Prepare the response payload with necessary details
            transportInfo = {
                id: pipeTransport.id, ip: pipeTransport.tuple.localIp, port: pipeTransport.tuple.localPort,
                srtpParameters: pipeTransport.srtpParameters,
                // --- Include producer details needed by the consuming side's transport.produce() ---
                kind: producer.kind,
                rtpParameters: producer.rtpParameters,
                paused: producer.paused,
                producerAppData: producer.appData
            };
            logger.info(`Room ${this.id}: Pipe transport ${pipeTransport.id} created locally, listening on ${transportInfo.ip}:${transportInfo.port}`);

        } catch (error) {
            logger.error(`Room ${this.id}: Failed creating local pipe transport for request ${pipeRequestId}:`, error);
            errorReason = error.message;
            if (pipeTransport && !pipeTransport.closed) pipeTransport.close();
        }

        // Respond via Redis
        const responseEvent = errorReason ? 'pipeCreationFailed' : 'pipeTransportReady';
        await this._redisManager.publish(this.id, responseEvent, {
             roomId: this.id, pipeRequestId, requestingInstanceId, producerId,
             transportInfo, reason: errorReason,
        });
    }

    /** Handles 'pipeTransportReady' event: Creates connecting transport, connects, creates pipe producer. */
    async _handlePipeTransportReady(pipeRequestId, producingInstanceId, producerId, remoteTransportInfo) {
        logger.info(`Room ${this.id}: Handling pipe transport ready for request ${pipeRequestId}, producer ${producerId} from instance ${producingInstanceId}`);
        await this.ensureRouterReady();
        if (!this.isRouterReady()) {
            logger.error(`Room ${this.id}: Router not ready, cannot establish pipe for ${producerId}.`);
             this._peers.forEach(peer => peer.rejectPendingConsumePipe(producerId, 'Local router became unavailable'));
            return;
        }

        // Validate required info received from the producing instance
        if (!remoteTransportInfo?.id || !remoteTransportInfo.ip || !remoteTransportInfo.port || !remoteTransportInfo.kind || !remoteTransportInfo.rtpParameters) {
             logger.error(`Room ${this.id}: Missing critical info in pipeTransportReady payload for producer ${producerId}`);
             this._peers.forEach(peer => peer.rejectPendingConsumePipe(producerId, 'Pipe setup failed: Incomplete remote info'));
             // Optionally notify the producing instance that the payload was bad?
             return; // Cannot proceed
        }

        let localPipeTransport = null;

        try {
             // Check if a pipe transport to this instance already exists and is usable
             let existingTransport = this._outgoingPipeTransports.get(producingInstanceId);
             if (existingTransport && !existingTransport.closed) {
                 localPipeTransport = existingTransport;
                 logger.debug(`Room ${this.id}: Reusing existing outgoing pipe transport ${localPipeTransport.id} to ${producingInstanceId}`);
             } else {
                // Create the connecting pipe transport on this (consuming) instance
                localPipeTransport = await this.router.createPipeTransport({
                    listenInfo: { // Provide listen details for this side
                        ...config.mediasoup.pipeTransportOptions.listenInfo,
                        announcedIp: config.mediasoup.webRtcTransportOptions.listenInfos[0].announcedIp
                    },
                    enableSctp : false,
                    appData: { pipeRequestId, type: 'pipe-connect', targetInstanceId: producingInstanceId }
                });
                this._outgoingPipeTransports.set(producingInstanceId, localPipeTransport);
                localPipeTransport.observer.once('close', () => {
                    logger.warn(`Room ${this.id}: Outgoing pipe transport ${localPipeTransport.id} to ${producingInstanceId} closed.`);
                    this._outgoingPipeTransports.delete(producingInstanceId);
                });

                // Connect this transport to the remote instance's listening transport
                await localPipeTransport.connect({
                    ip: remoteTransportInfo.ip,
                    port: remoteTransportInfo.port,
                    srtpParameters: remoteTransportInfo.srtpParameters // May be undefined if SRTP not used
                });
                logger.info(`Room ${this.id}: Local pipe transport ${localPipeTransport.id} connected to remote ${producingInstanceId}`);
             }


             // Create the local Producer that consumes from the remote producer via the pipe
             const pipeProducer = await localPipeTransport.produce({
                 producerId : producerId, // ID of the original remote producer
                 kind       : remoteTransportInfo.kind,
                 rtpParameters : remoteTransportInfo.rtpParameters,
                 paused     : remoteTransportInfo.paused,
                 appData    : {
                     ...(remoteTransportInfo.producerAppData || {}), // Include original appData
                     pipeRequestId,
                     originalProducerId: producerId,
                     producingInstanceId: producingInstanceId,
                     origin: 'pipe' // Mark this producer as originating from a pipe
                    }
             });

             // Listen for the pipe producer closing, e.g., if the underlying transport closes
             pipeProducer.observer.once('close', () => {
                 logger.warn(`Room ${this.id}: Pipe producer ${pipeProducer.id} (for original ${producerId}) closed.`);
                 // Consumers listening to this pipeProducer will get 'producerclose' event automatically
             });

             logger.info(`Room ${this.id}: Created local pipe producer ${pipeProducer.id} consuming remote producer ${producerId}`);

             // Notify the consuming peer(s) locally that the pipe producer is ready
             this._peers.forEach(peer => {
                 peer.resolvePendingConsumePipe(producerId, pipeProducer.id);
             });

        } catch (error) {
             logger.error(`Room ${this.id}: Failed handling pipeTransportReady for request ${pipeRequestId}:`, error);
             this._peers.forEach(peer => {
                 peer.rejectPendingConsumePipe(producerId, `Pipe connection/producer failed: ${error.message}`);
             });
             // Clean up the connecting transport if it was newly created and failed
             if (localPipeTransport && !this._outgoingPipeTransports.has(producingInstanceId) && !localPipeTransport.closed) {
                 localPipeTransport.close();
             }
        }
    }

    /** Handles 'pipeCreationFailed' event: Rejects pending consume requests. */
    _handlePipeCreationFailed(pipeRequestId, producingInstanceId, producerId, reason) {
         logger.error(`Room ${this.id}: Received pipe creation failed signal for producer ${producerId} from instance ${producingInstanceId}: ${reason}`);
         this._peers.forEach(peer => {
             peer.rejectPendingConsumePipe(producerId, `Remote pipe creation failed: ${reason}`);
         });
    }


    // --- Redis Event Handler ---
    async handleRedisEvent(eventType, data) {
        // No change needed here from previous 'fix all' version
        // It correctly routes to the internal _handle* methods
         logger.debug(`Room ${this.id}: Handling Redis event '${eventType}' from instance ${data.senderInstanceId}`);
        const payload = data.payload;
        const remoteInstanceId = data.senderInstanceId;

        try {
            switch (eventType) {
                case 'peerJoined': this.notifyLocalPeers('peerJoined', { peerId: payload.peerId }, null); break;
                case 'peerClosed':
                    // Reject pending consume requests for producers owned by the leaving peer
                    this._peers.forEach(p => {
                        // Check both remote producers map (if available) and local pipe producers appData
                        if (p._pendingConsumePipes.has(payload.producerId)) { // Simple check if key exists
                            p.rejectPendingConsumePipe(payload.producerId, `Producer owner ${payload.peerId} left`);
                        }
                        // More robust check might involve iterating _pendingConsumePipes and checking producerInfo from Redis
                    });
                    this.notifyLocalPeers('peerClosed', { peerId: payload.peerId }, null); break;
                case 'newProducer': this.notifyLocalPeers('newProducer', payload, null); break;
                case 'producerClosed':
                    this._peers.forEach(p => p.rejectPendingConsumePipe(payload.producerId, 'Producer closed remotely'));
                    this.notifyLocalPeers('producerClosed', payload, null); break;

                // Piping Events
                case 'requestPipeTransport':
                    if (payload.producingInstanceId === this._instanceId) await this._handlePipeTransportRequest(payload.pipeRequestId, payload.requestingInstanceId, payload.producerId);
                    break;
                case 'pipeTransportReady':
                    if (payload.requestingInstanceId === this._instanceId) await this._handlePipeTransportReady(payload.pipeRequestId, remoteInstanceId, payload.producerId, payload.transportInfo);
                    break;
                 case 'pipeCreationFailed':
                     if (payload.requestingInstanceId === this._instanceId) this._handlePipeCreationFailed(payload.pipeRequestId, remoteInstanceId, payload.producerId, payload.reason);
                     break;
            }
        } catch (error) {
             logger.error(`Room ${this.id}: Error handling Redis event ${eventType} from ${remoteInstanceId}:`, error);
        }
    }


    // --- Utilities ---
    /** Notifies locally connected peers, excluding one if specified. */
    notifyLocalPeers(method, params, excludePeerId = null) {
        this._peers.forEach(peer => {
            if (peer.id !== excludePeerId) {
                peer.notify(method, params);
            }
        });
    }

    /** Gets the router's RTP capabilities. */
    getRouterRtpCapabilities() {
        if (!this.isRouterReady()) throw errors.createError(errors.MEDIASOUP_ERROR, 'Router not initialized yet');
        return this.router.rtpCapabilities;
    }

    /** Gets basic information about the room state on this instance. */
    getRoomInfo() {
        const localPeersInfo = Array.from(this._peers.keys());
        const localProducersInfo = Array.from(this._peers.values()).flatMap(p => p.getAllProducers()).map(prod => ({
             id: prod.id, peerId: prod.appData.peerId, kind: prod.kind, appData: prod.appData
        }));
        return {
            roomId: this.id, instanceId: this._instanceId, routerId: this.router?.id,
            localPeers: localPeersInfo, localProducers: localProducersInfo,
            outgoingPipes: Array.from(this._outgoingPipeTransports.keys()),
            incomingPipes: Array.from(this._incomingPipeTransports.keys()),
        };
    }

    // --- Close Methods ---
    /** Closes all active pipe transports associated with this room instance. */
    _closeAllPipeTransports() {
         logger.warn(`Room ${this.id}: Closing all pipe transports.`);
         this._outgoingPipeTransports.forEach(t => { if (!t.closed) t.close(); });
         this._outgoingPipeTransports.clear();
         this._incomingPipeTransports.forEach(t => { if (!t.closed) t.close(); });
         this._incomingPipeTransports.clear();
    }

    /** Closes the room, including router, peers, and pipe transports. */
    close() {
        logger.warn(`Closing room ${this.id} resources on instance ${this._instanceId}.`);
        this._closeAllPipeTransports(); // Close pipes first

        // Close local peers gracefully
        this._peers.forEach(peer => {
            if(this._peers.has(peer.id)) { // Check if still present
                peer.close(`Room ${this.id} closing`);
            }
        });
        this._peers.clear(); // Clear local map

        // Close the router
        if (this.isRouterReady()) {
            this.router.close();
        }
        logger.info(`Room ${this.id}: Closed locally.`);
        // Note: Redis key cleanup (instance count, sets) happens in server.js handleLeaveRoom/shutdown
    }
}

module.exports = Room;