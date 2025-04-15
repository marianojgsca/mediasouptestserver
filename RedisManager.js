// RedisManager.js
const retry = require('async-retry');
const errors = require('./errors');

/**
 * Manages interactions with Redis for storing and retrieving room/peer/producer state.
 */
class RedisManager {
    #publisher;
    #subscriber;
    #instanceId;
    #config;
    #logger;
    #isReady = false;
    #retryOptions;

    /**
     * Creates an instance of RedisManager.
     * @param {object} redisClients - Object containing connected 'publisher' and 'subscriber' redis clients (node-redis v4+).
     * @param {string} instanceId - Unique ID of this server instance.
     * @param {object} config - Server configuration object.
     */
    constructor(redisClients, instanceId, config) {
        if (!redisClients.publisher || !redisClients.subscriber) {
            throw new Error('RedisManager requires connected publisher and subscriber clients.');
        }
        this.#publisher = redisClients.publisher;
        this.#subscriber = redisClients.subscriber; // Needed for subscribe/unsubscribe actions
        this.#instanceId = instanceId;
        this.#config = config;
        this.#logger = config.logger;
        this.#retryOptions = {
            retries: this.#config.redis.operationRetries,
            factor: 1.2, // Exponential backoff factor
            minTimeout: 50, // Minimum delay
            maxTimeout: 500, // Maximum delay
            onRetry: (error, attempt) => {
                this.#logger.warn(`Redis operation failed (attempt ${attempt}/${this.#retryOptions.retries + 1}), retrying: ${error.message}`);
            },
        };
        this._setupListeners(); // Setup listeners after clients are assigned
        this.#isReady = this.#publisher.isReady && this.#subscriber.isReady;
        this.#logger.info(`RedisManager initialized for instance ${instanceId}. Ready: ${this.#isReady}`);
    }

    _setupListeners() {
        const setupClientListeners = (client, name) => {
            client.on('ready', () => {
                this.#isReady = this.#publisher.isReady && this.#subscriber.isReady;
                // Only log manager ready state once
                if (this.#isReady && name === 'Publisher') this.#logger.info(`RedisManager is ready.`);
                this.#logger.info(`Redis ${name} ready.`);
            });
             client.on('end', () => {
                 this.#isReady = false;
                 this.#logger.warn(`Redis ${name} connection closed.`);
             });
            client.on('error', (err) => {
                this.#isReady = false; // Mark as not ready on error
                // Error logged by server.js Redis setup
            });
        };
        setupClientListeners(this.#publisher, 'Publisher');
        setupClientListeners(this.#subscriber, 'Subscriber');
    }

    get isReady() {
        // Ensure clients themselves report ready state
        return this.#isReady && this.#publisher.isReady && this.#subscriber.isReady;
    }

    /** Internal helper to execute Redis commands with retry logic. */
    async #doRedisOp(operationName, commandExecutor) {
        if (!this.isReady) {
            throw errors.createError(errors.INTERNAL_ERROR, 'Redis is not available');
        }
        try {
            return await retry(async (bail, attempt) => {
                 if (!this.isReady) {
                     bail(new Error('Redis became unavailable during operation'));
                     return;
                 }
                try {
                    // Pass publisher client to the executor function
                    return await commandExecutor(this.#publisher);
                } catch (error) {
                    // Retry common network/transient errors
                    if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED' || error.code === 'ENOTCONN' || error.message.includes('LOADING') || error.message.includes('closed')) {
                        this.#logger.warn(`Retrying Redis operation '${operationName}' (attempt ${attempt}) after error: ${error.message}`);
                        throw error; // Throw to trigger retry
                    } else {
                        this.#logger.error(`Unrecoverable Redis error during '${operationName}':`, error);
                        bail(error); // Stop retrying for other errors
                        return;
                    }
                }
            }, this.#retryOptions);
        } catch (error) {
            this.#logger.error(`Redis operation '${operationName}' failed after ${this.#retryOptions.retries} retries:`, error);
            throw errors.createError(errors.INTERNAL_ERROR, `Redis operation '${operationName}' failed: ${error.message}`);
        }
    }


    // --- Instance Info ---
    async updateInstanceInfo() {
        if (!this.#publisher || !this.#publisher.isReady) return; // Check publisher specifically
        const instanceKey = this.#config.redis.getInstanceKey(this.#instanceId);
        const instanceData = {
            instanceId: this.#instanceId,
            pipeListenIp: this.#config.mediasoup.webRtcTransportOptions.listenInfos[0].announcedIp,
            updatedAt: Date.now(),
        };
        try {
            await this.#publisher.set(instanceKey, JSON.stringify(instanceData), { EX: this.#config.redis.instanceExpirySec });
        } catch (error) { this.#logger.error(`Redis SET error for instance key ${instanceKey}:`, error); }
    }

    async removeInstanceInfo() {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const instanceKey = this.#config.redis.getInstanceKey(this.#instanceId);
        try { await this.#publisher.del(instanceKey); }
        catch (error) { this.#logger.error(`Redis DEL error for instance key ${instanceKey}:`, error); }
    }

    // --- Peer Lock ---
    async acquirePeerLock(roomId, peerId) {
        const key = this.#config.redis.getPeerKey(roomId, peerId);
        const setResult = await this.#doRedisOp('acquirePeerLock', client =>
            client.set(key, this.#instanceId, { NX: true, EX: 10 })
        );
        return setResult === 'OK';
    }

    async releasePeerLock(roomId, peerId) {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const key = this.#config.redis.getPeerKey(roomId, peerId);
        try { await this.#publisher.del(key); }
        catch (error) { this.#logger.error(`Redis DEL error for peer lock key ${key}:`, error); }
    }

    // --- Room State (Peers & Producers) ---
    async addPeerToRoom(roomId, peerId) {
        const keys = this.#config.redis.getKeys(roomId);
        await this.#doRedisOp('addPeerToRoom', client => client.sAdd(keys.peers, peerId));
    }

    async removePeerFromRoom(roomId, peerId) {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const keys = this.#config.redis.getKeys(roomId);
        try { await this.#publisher.sRem(keys.peers, peerId); }
        catch (error) { this.#logger.error(`Redis SREM error for room ${roomId}, peer ${peerId}:`, error); }
    }

    async getRoomPeers(roomId) {
        const keys = this.#config.redis.getKeys(roomId);
        return this.#doRedisOp('getRoomPeers', client => client.sMembers(keys.peers));
    }

    async addProducerToRoom(roomId, producerId, producerInfo) {
        const keys = this.#config.redis.getKeys(roomId);
        await this.#doRedisOp('addProducerToRoom', client => client.hSet(keys.producers, producerId, JSON.stringify(producerInfo)));
    }

    async removeProducerFromRoom(roomId, producerId) {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const keys = this.#config.redis.getKeys(roomId);
        try { await this.#publisher.hDel(keys.producers, producerId); }
        catch (error) { this.#logger.error(`Redis HDEL error for room ${roomId}, producer ${producerId}:`, error); }
    }

    async getRoomProducers(roomId) {
        const keys = this.#config.redis.getKeys(roomId);
        const producersMap = await this.#doRedisOp('getRoomProducers', client => client.hGetAll(keys.producers));
        try {
            return Object.values(producersMap).map(pJson => JSON.parse(pJson));
        } catch (parseError) {
            this.#logger.error(`Error parsing producer data for room ${roomId}:`, parseError);
            return [];
        }
    }

     async getProducerInfo(roomId, producerId) {
        const keys = this.#config.redis.getKeys(roomId);
        const infoJson = await this.#doRedisOp('getProducerInfo', client => client.hGet(keys.producers, producerId));
        try {
            return infoJson ? JSON.parse(infoJson) : null;
        } catch (parseError) {
             this.#logger.error(`Error parsing producer info for ${producerId} in room ${roomId}:`, parseError);
             return null;
        }
    }


    // --- Room Instance Tracking ---
    async addInstanceToRoom(roomId) {
        const keys = this.#config.redis.getKeys(roomId);
        await this.#doRedisOp('addInstanceToRoom', async (client) => {
            const multi = client.multi();
            multi.sAdd(keys.instances, this.#instanceId);
            multi.incr(keys.instanceCount);
            return multi.exec();
        });
    }

    async removeInstanceFromRoom(roomId) {
        if (!this.isReady) return 0;
        const keys = this.#config.redis.getKeys(roomId);
        let remainingCount = 0;
        try {
            const results = await this.#doRedisOp('removeInstanceFromRoom', async (client) => {
                 const multi = client.multi();
                 multi.sRem(keys.instances, this.#instanceId);
                 multi.decr(keys.instanceCount);
                 return multi.exec();
            });
            // Ensure result array exists and has expected length
            remainingCount = (results && results.length > 1 && typeof results[1] === 'number') ? results[1] : 0;

            if (remainingCount < 0) {
                this.#logger.warn(`Room ${roomId} instance count went below zero (${remainingCount}), resetting to 0.`);
                try { await this.#publisher.set(keys.instanceCount, 0); } catch { /* ignore */ }
                remainingCount = 0;
            }
        } catch (error) {
             // Error already logged by doRedisOp
             remainingCount = await this.getRoomInstanceCount(roomId); // Fallback
        }
        return remainingCount;
    }

    async getRoomInstanceCount(roomId) {
        if (!this.isReady) return 0;
        const keys = this.#config.redis.getKeys(roomId);
        try {
             const countStr = await this.#doRedisOp('getRoomInstanceCount', client => client.get(keys.instanceCount));
             return parseInt(countStr || '0');
        } catch { return 0; }
    }

    async maybeCleanupRoomKeys(roomId, currentInstanceCount) {
        if (!this.isReady) return;
        if (currentInstanceCount <= 0) {
            this.#logger.warn(`Room ${roomId}: Last known instance left. Attempting to delete global room keys.`);
            const keys = this.#config.redis.getKeys(roomId);
            const keysToDelete = [ keys.instances, keys.instanceCount, keys.peers, keys.producers ];
            try {
                await this.#publisher.del(keysToDelete); // No retry on cleanup DEL
                this.#logger.info(`Room ${roomId}: Successfully deleted global keys.`);
            } catch (error) { this.#logger.error(`Redis DEL error during room ${roomId} cleanup:`, error); }
        }
    }

    // --- Pub/Sub ---
    async subscribe(roomId, handler) {
        if (!this.#subscriber || !this.#subscriber.isReady) {
            throw errors.createError(errors.INTERNAL_ERROR, 'Redis subscriber not available');
        }
        const channel = this.#config.redis.getRoomChannel(roomId);
        try {
            await this.#subscriber.subscribe(channel, handler);
            this.#logger.info(`Subscribed to Redis channel: ${channel}`);
        } catch (error) {
            this.#logger.error(`Redis SUBSCRIBE error for channel ${channel}:`, error);
            throw errors.createError(errors.INTERNAL_ERROR, 'Redis error subscribing');
        }
    }

    async unsubscribe(roomId) {
        if (!this.#subscriber || !this.#subscriber.isReady) return;
        const channel = this.#config.redis.getRoomChannel(roomId);
        try { await this.#subscriber.unsubscribe(channel); }
        catch (error) { this.#logger.error(`Redis UNSUBSCRIBE error for channel ${channel}:`, error); }
    }

    async publish(roomId, eventType, payload) {
        if (!this.isReady) {
            this.#logger.warn(`Cannot publish event ${eventType} to room ${roomId}, Redis not ready.`);
            return;
        }
        const channel = this.#config.redis.getRoomChannel(roomId);
        const message = JSON.stringify({
            senderInstanceId: this.#instanceId,
            type: eventType,
            payload: payload,
        });
        try { await this.#publisher.publish(channel, message); } // No retry on publish
        catch (error) { this.#logger.error(`Redis PUBLISH error to channel ${channel}:`, error); }
    }

     // --- Cleanup ---
     async quit() {
        this.#logger.warn('Closing Redis connections...');
        // Use Promise.allSettled to ensure both quits are attempted
        const results = await Promise.allSettled([
            this.#publisher?.quit(),
            this.#subscriber?.quit()
        ]);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                this.#logger.error(`Error closing Redis ${index === 0 ? 'publisher' : 'subscriber'}:`, result.reason);
            }
        });
        this.#isReady = false; // Mark as not ready after quit attempts
        this.#logger.info('Redis quit commands sent.');
     }
}

module.exports = RedisManager;