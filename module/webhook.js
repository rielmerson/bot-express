'use strict';

const REQUIRED_OPTIONS = {
    line: ["line_channel_id", "line_channel_secret", "line_channel_access_token"],
    facebook: ["facebook_app_secret", "facebook_page_access_token"]
}

// Import NPM Packages
let Promise = require("bluebird");
let memory = require("memory-cache");
let debug = require("debug")("bot-express:webhook");

// Import Flows
let beacon_flow = require('./flow/beacon');
let start_conversation_flow = require('./flow/start_conversation');
let restart_conversation_flow = require('./flow/restart_conversation');
let reply_flow = require('./flow/reply');
let change_intent_flow = require('./flow/change_intent');
let change_parameter_flow = require('./flow/change_parameter');
let no_way_flow = require('./flow/no_way');

// Import NLP Abstraction.
let Nlp = require("./nlp");

// Import Messenger Abstraction.
let Messenger = require("./messenger");

module.exports = class webhook {
    constructor(options){
        this.options = options;
    }

    run(req){
        debug("\nWebhook runs.\n");

        // FOR TEST PURPOSE ONLY: Clear Memory.
        if (process.env.BOT_EXPRESS_ENV == "test" && req.clear_memory){
            debug(`Deleting memory of ${req.clear_memory}`);
            memory.del(req.clear_memory);
            return Promise.resolve({
                message: "memory cleared",
                memory_id: req.clear_memory
            });
        }

        // Identify Message Platform.
        if (req.get("X-Line-Signature") && req.body.events){
            this.options.message_platform_type = "line";
        } else if (req.get("X-Hub-Signature") && req.body.object == "page"){
            this.options.message_platform_type = "facebook";
        } else {
            return Promise.resolve(`This event comes from unsupported message platform. Skip processing.`);
        }
        debug(`Message Platform is ${this.options.message_platform_type}`);

        // Check if required options for this message platform are set.
        for (let req_opt of REQUIRED_OPTIONS[this.options.message_platform_type]){
            if (typeof this.options[req_opt] == "undefined"){
                return Promise.reject({
                    reason: "required option missing",
                    missing_option: req_opt
                });
            }
        }
        debug("Message Platform specific required options all set.");

        // Instantiate Message Platform.
        let messenger = new Messenger(this.options);
        debug("Messenger Abstraction instantiated.");

        // Signature Validation.
        if (!messenger.validate_signature(req)){
            return Promise.reject("Signature Validation failed.");
        }
        debug("Signature Validation suceeded.");

        // Set Events.
        let bot_events = messenger.extract_events(req.body);

        for (let bot_event of bot_events){
            debug(`Processing following event.`);
            debug(bot_event);

            messenger.bot_event = bot_event;

            // Recall Memory
            let memory_id = messenger.extract_sender_id();
            debug(`memory id is ${memory_id}.`);

            let context = memory.get(memory_id);
            messenger.context = context;

            let promise_flow_completed;
            let flow;

            if (messenger.extract_event_type() == "beacon"){
                /*
                ** Beacon Flow
                */
                let beacon_event_type = messenger.extract_beacon_event_type();

                if (!beacon_event_type){
                    return Promise.resolve("Unsupported beacon event.");
                }
                if (!this.options.beacon_skill || !this.options.beacon_skill[beacon_event_type]){
                    return Promise.resolve(`This is beacon flow but beacon_skill["${beacon_event_type}"] not found so skip.`);
                }
                debug(`This is beacon flow and we use ${this.options.beacon_skill[beacon_event_type]} as skill`);

                // Instantiate the conversation object. This will be saved as Bot Memory.
                context = {
                    intent: {name: this.options.beacon_skill[beacon_event_type]},
                    confirmed: {},
                    to_confirm: [],
                    confirming: null,
                    previous: {
                        confirmed: [],
                        message: []
                    }
                };
                messenger.context = context;
                try {
                    flow = new beacon_flow(messenger, bot_event, context, this.options);
                } catch(err) {
                    return Promise.reject(err);
                }
                promise_flow_completed = flow.run();
            } else if (!context){
                /*
                ** Start Conversation Flow.
                */
                try {
                    flow = new start_conversation_flow(messenger, bot_event, this.options);
                } catch(err) {
                    return Promise.reject(err);
                }
                promise_flow_completed = flow.run();
                // End of Start Conversation Flow.
            } else {
                if (context.confirming){
                    /*
                    ** Reply Flow
                    */
                    try {
                        flow = new reply_flow(messenger, bot_event, context, this.options);
                    } catch(err){
                        return Promise.reject(err);
                    }
                    promise_flow_completed = flow.run();
                    // End of Reply Flow
                } else {
                    // Check if this is Change Intent Flow.
                    let promise_is_change_intent_flow;

                    if (!messenger.check_supported_event_type("change_intent")){
                        promise_is_change_intent_flow = new Promise((resolve, reject) => {
                            resolve({
                                result: false,
                                intent: {fulfillment: {speech: ""}},
                                reason: "unsupported event for change intent flow"
                            });
                        });
                    } else {
                        // Set session id for api.ai and text to identify intent.
                        let session_id = messenger.extract_sender_id();
                        let message_text = messenger.extract_message_text();

                        // Translation
                        let translated;
                        if (!messenger.translater){
                            translated = Promise.resolve(message_text);
                        } else {
                            // If sender language is different from bot language, we translate message into bot language.
                            translated = messenger.translater.detect(message_text).then(
                                (response) => {
                                    context.sender_language = response[0].language;
                                    debug(`Bot language is ${this.options.nlp_options.language} and sender language is ${context.sender_language}`);

                                    // If sender language is different from bot language, we translate message into bot language.
                                    if (this.options.nlp_options.language === context.sender_language){
                                        debug("We do not translate message text.");
                                        return [message_text];
                                    } else {
                                        debug("Translating message text...");
                                        return messenger.translater.translate(message_text, this.options.nlp_options.language)
                                    }
                                }
                            ).then(
                                (response) => {
                                    debug("Translater response follows.");
                                    debug(response);
                                    return response[0];
                                }
                            );
                        }

                        promise_is_change_intent_flow = translated.then(
                            (message_text) => {
                                // ### Identify Intent ###
                                let nlp = new Nlp(this.options.nlp, this.options.nlp_options);
                                debug("NLP Abstraction instantiated.");
                                return nlp.identify_intent(message_text, {
                                    session_id: session_id
                                });
                            }
                        ).then(
                            (intent) => {
                                if (intent.name != this.options.default_intent){
                                    // This is change intent flow or restart intent flow.
                                    debug("This is change intent flow or restart intent flow since we could identify intent.");
                                    return {
                                        result: true,
                                        intent: intent
                                    }
                                } else {
                                    debug("This is not change intent flow since we could not identify intent.");
                                    return {
                                        result: false,
                                        intent: intent
                                    }
                                }
                            }
                        );
                    }

                    promise_flow_completed = promise_is_change_intent_flow.then(
                        (response) => {
                            if (response.result){
                                if (response.intent.name == context.intent.name){
                                    /*
                                    ** Restart Conversation Flow
                                    */
                                    try {
                                        flow = new restart_conversation_flow(messenger, bot_event, response.intent, context, this.options);
                                    } catch(err) {
                                        return Promise.reject(err);
                                    }
                                    return flow.run();
                                    // End of Restart Conversation Flow
                                } else {
                                    /*
                                    ** Change Intent Flow
                                    */
                                    // Set new intent while keeping other data.
                                    context.intent = response.intent;
                                    try {
                                        flow = new change_intent_flow(messenger, bot_event, context, this.options);
                                    } catch(err){
                                        return Promise.reject(err);
                                    }
                                    return flow.run();
                                    // End of Change Intent Flow
                                }
                            } else {
                                let identified_intent = response.intent; // This should be an unknown intent. Will be used in no way flow.

                                // Check if this is Change Parameter Flow.
                                let promise_is_change_parameter_flow;
                                if (!context.previous.confirmed || context.previous.confirmed.length == 0 || context.intent.name == this.options.default_intent){
                                    // This is not Change Parameter Flow.
                                    debug("This is not change parameter flow since we cannot find previously confirmed parameter. Or previous intent was default intent.")
                                    promise_is_change_parameter_flow = new Promise((resolve, reject) => {
                                        resolve({
                                            result: false
                                        });
                                    });
                                } else {
                                    // Assume this is Change Parameter Flow.
                                    try {
                                        flow = new change_parameter_flow(messenger, bot_event, context, this.options);
                                    } catch(err){
                                        return Promise.reject(err);
                                    }
                                    promise_is_change_parameter_flow = flow.run();
                                }

                                return promise_is_change_parameter_flow.then(
                                    (response) => {
                                        if (response.result){
                                            /*
                                            ** This was Change Parameter Flow
                                            */
                                            debug("This was change parameter flow since we could change parameter.");
                                            return response.response;
                                        }

                                        /*
                                        ** This is No Way Flow
                                        */
                                        context.intent = identified_intent;
                                        try {
                                            flow = new no_way_flow(messenger, bot_event, context, this.options);
                                        } catch(err){
                                            return Promise.reject(err);
                                        }
                                        return flow.run();
                                    }
                                );
                            }
                        }
                    );
                }
            }

            // Completion of Flow
            return promise_flow_completed.then(
                (response) => {
                    debug("Successful End of Flow.");

                    // Update memory.
                    memory.put(memory_id, flow.context, this.options.memory_retention);

                    return flow.context;
                },
                (response) => {
                    debug("Abnormal End of Flow.");

                    // Clear memory.
                    memory.del(memory_id);

                    return Promise.reject(response);
                }
            ); // End of Completion of Flow

        }; // End of Process Event
    }
}
