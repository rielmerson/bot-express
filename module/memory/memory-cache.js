"use strict";

const memory_cache = require("memory-cache");
const debug = require("debug")("bot-express:memory");

class MemoryMemoryCache {
    /**
     * @constructor
     * @param {Object} options
     */
    constructor(options){
        this.client = memory_cache;
    }

    async get(key){
        const context = this.client.get(key);
        const copy = JSON.parse(JSON.stringify(context));
        return copy;
    }

    async put(key, context){
        const copy = JSON.parse(JSON.stringify(context));
        return this.client.put(key, copy);
    }

    /*
    async put(key, context, retention){
        return this.client.put(key, context, retention * 1000, async (key, context) => {
            if (context.confirming && context.skill){
                // Log skill status.
                await this.logger.skill_status(key.replace(prefix, ""), context.chat_id, context.skill.type, "aborted", {
                    context:context 
                });

                // Run on_abort function.
                if (typeof context.skill.on_abort == "function"){
                    await context.skill.on_abort(context);
                }
            }
        });
    }
    */

    async del(key){
        return this.client.del(key);
    }

    /**
    @deprecated
    */
    async close(){
        // memory-cache does not have to close connection so this is dummy.
        return;
    }
}

module.exports = MemoryMemoryCache;
